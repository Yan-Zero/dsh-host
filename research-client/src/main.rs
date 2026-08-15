use serde::Deserialize;
use serde_json::{json, Value};
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Endpoint {
    host: String,
    port: u16,
    token_file: PathBuf,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args().skip(1);
    let endpoint_path = args.next().ok_or("usage: dsh-host-client <endpoint.json> [method] [payload-json]")?;
    let method = args.next().unwrap_or_else(|| "host.describe".into());
    let payload: Value = match args.next() {
        Some(raw) => serde_json::from_str(&raw)?,
        None => json!({}),
    };
    let endpoint: Endpoint = serde_json::from_str(&fs::read_to_string(endpoint_path)?)?;
    let token = fs::read_to_string(&endpoint.token_file)?.trim().to_owned();
    let body = serde_json::to_vec(&json!({
        "type": "client-request",
        "rpcId": "dsh-host-client",
        "method": method,
        "payload": payload,
    }))?;
    let mut stream = TcpStream::connect((endpoint.host.as_str(), endpoint.port))?;
    write!(
        stream,
        "POST /api/{method} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nX-DSH-Host-Token: {token}\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n",
        method = method,
        port = endpoint.port,
        token = token,
        length = body.len(),
    )?;
    stream.write_all(&body)?;
    let mut response = String::new();
    stream.read_to_string(&mut response)?;
    let (response_head, response_body) = response.split_once("\r\n\r\n").ok_or("invalid HTTP response")?;
    let decoded;
    let response_body = if response_head.lines().any(|line| line.eq_ignore_ascii_case("transfer-encoding: chunked")) {
        decoded = decode_chunked(response_body)?;
        decoded.as_str()
    } else {
        response_body
    };
    let value: Value = serde_json::from_str(response_body)?;
    println!("{}", serde_json::to_string_pretty(&value)?);
    Ok(())
}

fn decode_chunked(mut input: &str) -> Result<String, Box<dyn std::error::Error>> {
    let mut output = String::new();
    loop {
        let (size_line, rest) = input.split_once("\r\n").ok_or("invalid chunk size line")?;
        let size_token = size_line.split(';').next().ok_or("missing chunk size")?;
        let size = usize::from_str_radix(size_token.trim(), 16)?;
        input = rest;
        if size == 0 {
            return Ok(output);
        }
        if input.len() < size + 2 || !input.is_char_boundary(size) {
            return Err("invalid chunk body".into());
        }
        output.push_str(&input[..size]);
        if &input[size..size + 2] != "\r\n" {
            return Err("chunk body missing terminator".into());
        }
        input = &input[size + 2..];
    }
}
