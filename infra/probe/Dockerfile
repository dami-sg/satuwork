FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      bubblewrap gcc libc6-dev linux-libc-dev procps util-linux ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY landlock-abi.c /tmp/landlock-abi.c
RUN gcc -O1 -o /usr/local/bin/landlock-abi /tmp/landlock-abi.c && rm /tmp/landlock-abi.c

# unprivileged user: bubblewrap's real-world usage is non-root + user namespaces,
# so the probe must exercise that path, not just root.
RUN useradd -m -u 10001 prober

COPY probe.sh /usr/local/bin/probe.sh
RUN chmod +x /usr/local/bin/probe.sh

CMD ["/usr/local/bin/probe.sh"]
