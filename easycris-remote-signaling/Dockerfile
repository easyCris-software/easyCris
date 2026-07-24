FROM rust:1.85-bookworm AS builder
WORKDIR /app
COPY Cargo.toml Cargo.lock* ./
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim
RUN useradd --system --uid 10001 --create-home easycris
WORKDIR /app
COPY --from=builder /app/target/release/easycris-remote-signaling /usr/local/bin/easycris-remote-signaling
USER easycris
EXPOSE 8080
CMD ["easycris-remote-signaling"]
