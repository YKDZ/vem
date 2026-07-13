FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssh-client openssh-server \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --badname -m -s /bin/bash YKDZ \
  && passwd -d YKDZ \
  && mkdir -p /run/sshd /etc/ssh/auth_principals \
  && ssh-keygen -A

CMD ["sleep", "infinity"]
