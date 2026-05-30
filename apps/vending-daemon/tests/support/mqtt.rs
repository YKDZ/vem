use std::{thread, time::Duration};

use config::{Config, File, FileFormat};
use portpicker::pick_unused_port;
use rumqttc::{AsyncClient, Event, EventLoop, MqttOptions, Packet};

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
