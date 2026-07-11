use std::{
    io,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};

use config::{Config, File, FileFormat};
use portpicker::pick_unused_port;
use rumqttc::{AsyncClient, Event, EventLoop, MqttOptions, Packet};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Mutex,
};

pub struct MqttBrokerHarness {
    port: u16,
    _thread: thread::JoinHandle<()>,
}

impl MqttBrokerHarness {
    pub async fn start() -> Self {
        let port = pick_unused_port().expect("free mqtt port");
        let toml = format!(
            r#"
id = 0

[router]
id = 0
max_connections = 100
max_outgoing_packet_count = 200
max_segment_size = 10485760
max_segment_count = 10

[v4.1]
name = "v4-test"
listen = "127.0.0.1:{port}"
next_connection_delay_ms = 1

[v4.1.connections]
connection_timeout_ms = 60000
max_payload_size = 20480
max_inflight_count = 100
dynamic_filters = true
"#
        );
        let config: rumqttd::Config = Config::builder()
            .add_source(File::from_str(&toml, FileFormat::Toml))
            .build()
            .expect("broker config")
            .try_deserialize()
            .expect("deserialize broker config");
        let handle = thread::spawn(move || {
            let mut broker = rumqttd::Broker::new(config);
            broker.start().expect("rumqttd broker");
        });
        wait_for_tcp(port).await;
        Self {
            port,
            _thread: handle,
        }
    }

    pub fn url(&self) -> String {
        format!("mqtt://127.0.0.1:{}", self.port)
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn client(&self, id: &str) -> (AsyncClient, EventLoop) {
        let mut options = MqttOptions::new(id, "127.0.0.1", self.port);
        options.set_keep_alive(Duration::from_secs(5));
        AsyncClient::new(options, 16)
    }
}

async fn wait_for_tcp(port: u16) {
    for _ in 0..100 {
        if tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_ok()
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("mqtt broker did not listen on port {port}");
}

pub async fn collect_publishes(
    event_loop: &mut EventLoop,
    expected: usize,
) -> Vec<(String, Vec<u8>)> {
    let mut out = Vec::new();
    while out.len() < expected {
        if let Event::Incoming(Packet::Publish(publish)) =
            tokio::time::timeout(Duration::from_secs(10), event_loop.poll())
                .await
                .expect("mqtt collect timeout")
                .expect("mqtt event")
        {
            out.push((publish.topic, publish.payload.to_vec()));
        }
    }
    out
}

pub fn spawn_event_loop(mut event_loop: EventLoop) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            if event_loop.poll().await.is_err() {
                break;
            }
        }
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObservedQos1Publish {
    pub packet_id: u16,
    pub topic: String,
}

/// Forwards the first QoS1 PUBLISH to the real broker and drops the TCP
/// connection before its PubAck can return to the daemon.
pub struct PubAckDropProxy {
    port: u16,
    dropped: Arc<AtomicBool>,
    publishes: Arc<Mutex<Vec<ObservedQos1Publish>>>,
    _task: tokio::task::JoinHandle<()>,
}

impl PubAckDropProxy {
    pub async fn start(broker_port: u16) -> Self {
        let port = pick_unused_port().expect("free mqtt proxy port");
        let listener = TcpListener::bind(("127.0.0.1", port))
            .await
            .expect("bind mqtt proxy");
        let dropped = Arc::new(AtomicBool::new(false));
        let publishes = Arc::new(Mutex::new(Vec::new()));
        let task_dropped = dropped.clone();
        let task_publishes = publishes.clone();
        let task = tokio::spawn(async move {
            while let Ok((client, _)) = listener.accept().await {
                let dropped = task_dropped.clone();
                let publishes = task_publishes.clone();
                tokio::spawn(async move {
                    let _ = proxy_connection(client, broker_port, dropped, publishes).await;
                });
            }
        });
        Self {
            port,
            dropped,
            publishes,
            _task: task,
        }
    }

    pub fn url(&self) -> String {
        format!("mqtt://127.0.0.1:{}", self.port)
    }

    pub fn dropped_before_puback(&self) -> bool {
        self.dropped.load(Ordering::SeqCst)
    }

    pub async fn qos1_publishes(&self) -> Vec<ObservedQos1Publish> {
        self.publishes.lock().await.clone()
    }
}

async fn proxy_connection(
    client: TcpStream,
    broker_port: u16,
    dropped: Arc<AtomicBool>,
    publishes: Arc<Mutex<Vec<ObservedQos1Publish>>>,
) -> io::Result<()> {
    let broker = TcpStream::connect(("127.0.0.1", broker_port)).await?;
    let (mut client_read, mut client_write) = client.into_split();
    let (mut broker_read, mut broker_write) = broker.into_split();
    let armed = Arc::new(AtomicBool::new(false));
    let client_armed = armed.clone();
    let client_publishes = publishes.clone();
    let client_dropped = dropped.clone();
    let forward = tokio::spawn(async move {
        loop {
            let Some(packet) = read_mqtt_packet(&mut client_read).await? else {
                return Ok::<(), io::Error>(());
            };
            if let Some(publish) = qos1_publish(&packet) {
                // Arm before the broker can observe this write. The reverse
                // parser therefore cannot race a broker PubAck through to the
                // daemon between forward and disconnect.
                if !client_dropped.load(Ordering::SeqCst) {
                    client_armed.store(true, Ordering::SeqCst);
                }
                broker_write.write_all(&packet).await?;
                broker_write.flush().await?;
                client_publishes.lock().await.push(publish);
            } else {
                broker_write.write_all(&packet).await?;
                broker_write.flush().await?;
            }
        }
    });
    loop {
        let Some(packet) = read_mqtt_packet(&mut broker_read).await? else {
            break;
        };
        if armed.load(Ordering::SeqCst) && is_puback(&packet) {
            dropped.store(true, Ordering::SeqCst);
            forward.abort();
            return Ok(());
        }
        client_write.write_all(&packet).await?;
        client_write.flush().await?;
    }
    forward.abort();
    Ok(())
}

async fn read_mqtt_packet(
    reader: &mut tokio::net::tcp::OwnedReadHalf,
) -> io::Result<Option<Vec<u8>>> {
    let mut first = [0_u8; 1];
    match reader.read_exact(&mut first).await {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let mut packet = vec![first[0]];
    let mut remaining = 0_usize;
    let mut multiplier = 1_usize;
    for _ in 0..4 {
        let mut encoded = [0_u8; 1];
        reader.read_exact(&mut encoded).await?;
        packet.push(encoded[0]);
        remaining += usize::from(encoded[0] & 0x7f) * multiplier;
        if encoded[0] & 0x80 == 0 {
            break;
        }
        multiplier *= 128;
    }
    if packet.last().is_some_and(|value| value & 0x80 != 0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid MQTT remaining length",
        ));
    }
    let offset = packet.len();
    packet.resize(offset + remaining, 0);
    reader.read_exact(&mut packet[offset..]).await?;
    Ok(Some(packet))
}

fn qos1_publish(packet: &[u8]) -> Option<ObservedQos1Publish> {
    if packet.first().copied()? >> 4 != 3 || (packet[0] >> 1) & 0x3 != 1 {
        return None;
    }
    let mut body = 1;
    while packet.get(body)? & 0x80 != 0 {
        body += 1;
    }
    body += 1;
    let topic_length = usize::from(*packet.get(body)?) << 8 | usize::from(*packet.get(body + 1)?);
    let topic_start = body + 2;
    let packet_id = u16::from_be_bytes([
        *packet.get(topic_start + topic_length)?,
        *packet.get(topic_start + topic_length + 1)?,
    ]);
    let topic = String::from_utf8(
        packet
            .get(topic_start..topic_start + topic_length)?
            .to_vec(),
    )
    .ok()?;
    Some(ObservedQos1Publish { packet_id, topic })
}

fn is_puback(packet: &[u8]) -> bool {
    packet
        .first()
        .is_some_and(|first| first >> 4 == 4 && first & 0x0f == 0)
        && packet.len() >= 4
}
