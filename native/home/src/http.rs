//! HTTP/1.1 to the Glasshouse server. The server is on the same TV (or, for
//! the computer preview, on the network), plain HTTP, one request per
//! connection, so a small client is enough and keeps TLS out of the binary.

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

pub struct Reply {
    pub status: u16,
    pub body: Vec<u8>,
}

/// `base` is `host:port`. 8 s, as the web view's requests.
pub fn request(base: &str, method: &str, path: &str, body: Option<&str>) -> Result<Reply, String> {
    let timeout = Duration::from_secs(8);
    let addr = base
        .to_socket_addrs()
        .map_err(|e| format!("{}: {}", base, e))?
        .next()
        .ok_or_else(|| format!("{}: no address", base))?;
    let mut s = TcpStream::connect_timeout(&addr, timeout).map_err(|e| format!("connect {}: {}", base, e))?;
    s.set_read_timeout(Some(timeout)).ok();
    s.set_write_timeout(Some(timeout)).ok();
    s.set_nodelay(true).ok();
    let mut req = format!("{} {} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\nAccept-Encoding: identity\r\n", method, path, base);
    // The computer preview reaches the server over the network, which needs
    // the token; requests from the TV itself do not.
    if let Ok(t) = std::env::var("GLASSHOUSE_TOKEN") {
        req.push_str(&format!("Authorization: Bearer {}\r\n", t));
    }
    if let Some(b) = body {
        req.push_str(&format!("Content-Type: application/json\r\nContent-Length: {}\r\n", b.len()));
    }
    req.push_str("\r\n");
    if let Some(b) = body {
        req.push_str(b);
    }
    s.write_all(req.as_bytes()).map_err(|e| format!("send: {}", e))?;
    let mut raw = Vec::with_capacity(16 * 1024);
    s.read_to_end(&mut raw).map_err(|e| format!("read: {}", e))?;
    parse(&raw)
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

fn parse(raw: &[u8]) -> Result<Reply, String> {
    let end = find(raw, b"\r\n\r\n").ok_or("no header end")?;
    let head = String::from_utf8_lossy(&raw[..end]).into_owned();
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .and_then(|l| l.split(' ').nth(1))
        .and_then(|c| c.parse::<u16>().ok())
        .ok_or("bad status line")?;
    let mut chunked = false;
    for l in lines {
        let lower = l.to_ascii_lowercase();
        if lower.starts_with("transfer-encoding:") && lower.contains("chunked") {
            chunked = true;
        }
    }
    let rest = &raw[end + 4..];
    let body = if chunked { dechunk(rest)? } else { rest.to_vec() };
    Ok(Reply { status, body })
}

fn dechunk(mut b: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    loop {
        let e = find(b, b"\r\n").ok_or("bad chunk")?;
        let size_str = String::from_utf8_lossy(&b[..e]);
        let size = usize::from_str_radix(size_str.split(';').next().unwrap_or("").trim(), 16).map_err(|_| "bad chunk size")?;
        b = &b[e + 2..];
        if size == 0 {
            return Ok(out);
        }
        if b.len() < size {
            return Err("short chunk".into());
        }
        out.extend_from_slice(&b[..size]);
        b = &b[size..];
        if b.starts_with(b"\r\n") {
            b = &b[2..];
        }
    }
}

pub fn get_json(base: &str, path: &str) -> Result<serde_json::Value, String> {
    let r = request(base, "GET", path, None)?;
    if r.status < 200 || r.status >= 300 {
        return Err(format!("{} {}", path, r.status));
    }
    serde_json::from_slice(&r.body).map_err(|e| format!("{}: {}", path, e))
}

/// The reply's JSON whatever the status, since the server answers refusals
/// with `{ ok: false, error }` that the view shows.
pub fn post_json(base: &str, path: &str, body: &serde_json::Value) -> Result<(u16, serde_json::Value), String> {
    let r = request(base, "POST", path, Some(&body.to_string()))?;
    let j = serde_json::from_slice(&r.body).unwrap_or(serde_json::Value::Null);
    Ok((r.status, j))
}

pub fn get_bytes(base: &str, path: &str) -> Result<Vec<u8>, String> {
    let r = request(base, "GET", path, None)?;
    if r.status < 200 || r.status >= 300 {
        return Err(format!("{} {}", path, r.status));
    }
    Ok(r.body)
}
