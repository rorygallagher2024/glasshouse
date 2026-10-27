//! The dashboards' t('key', 'English', {vars}) (assets/i18n.js): a translation
//! is used only while its `from` still matches the English, so a changed
//! string falls back to English rather than showing an old meaning.

use std::collections::HashMap;

pub struct I18n {
    pub lang: String,
    dict: HashMap<String, (String, String)>,
}

impl I18n {
    pub fn load(assets: &str, lang: &str) -> I18n {
        let mut dict = HashMap::new();
        if lang != "en" {
            if let Ok(b) = std::fs::read(format!("{}/i18n/{}.json", assets, lang)) {
                if let Ok(serde_json::Value::Object(m)) = serde_json::from_slice::<serde_json::Value>(&b) {
                    for (k, v) in m {
                        if let (Some(f), Some(t)) = (v.get("from").and_then(|x| x.as_str()), v.get("text").and_then(|x| x.as_str())) {
                            dict.insert(k, (f.to_string(), t.to_string()));
                        }
                    }
                }
            }
        }
        I18n { lang: lang.to_string(), dict }
    }

    pub fn t(&self, key: &str, english: &str, vars: &[(&str, String)]) -> String {
        let text = match self.dict.get(key) {
            Some((from, text)) if from == english => text.as_str(),
            _ => english,
        };
        if vars.is_empty() {
            return text.to_string();
        }
        let mut out = String::with_capacity(text.len() + 16);
        let mut rest = text;
        while let Some(open) = rest.find('{') {
            out.push_str(&rest[..open]);
            let after = &rest[open + 1..];
            match after.find('}') {
                Some(close) if after[..close].chars().all(|c| c.is_alphanumeric() || c == '_') => {
                    let name = &after[..close];
                    match vars.iter().find(|(n, _)| *n == name) {
                        Some((_, v)) => out.push_str(v),
                        None => {
                            out.push('{');
                            out.push_str(name);
                            out.push('}');
                        }
                    }
                    rest = &after[close + 1..];
                }
                _ => {
                    out.push('{');
                    rest = after;
                }
            }
        }
        out.push_str(rest);
        out
    }

    pub fn weekday(&self, d: usize) -> &'static str {
        const EN: [&str; 7] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
        const ES: [&str; 7] = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
        if self.lang == "es" { ES[d % 7] } else { EN[d % 7] }
    }

    pub fn month(&self, m: usize) -> &'static str {
        const EN: [&str; 12] =
            ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
        const ES: [&str; 12] =
            ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
        if self.lang == "es" { ES[m % 12] } else { EN[m % 12] }
    }
}

pub struct LocalTime {
    pub hour: i32,
    pub min: i32,
    pub mday: i32,
    pub mon: i32,
    pub wday: i32,
}

#[cfg(target_pointer_width = "32")]
type TimeT = i32;
#[cfg(target_pointer_width = "64")]
type TimeT = i64;

extern "C" {
    fn localtime_r(t: *const TimeT, out: *mut [i32; 16]) -> *mut [i32; 16];
    fn tzset();
}

static TZ_READ: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(-1);

/// The TV's local time for a Unix time in milliseconds, the time zone read
/// again once a minute rather than at every call.
pub fn local(ms: f64) -> LocalTime {
    let t = (ms / 1000.0).floor() as TimeT;
    let minute = (now_ms() / 60000.0) as i64;
    let mut tm = [0i32; 16];
    unsafe {
        if TZ_READ.swap(minute, std::sync::atomic::Ordering::Relaxed) != minute {
            tzset();
        }
        localtime_r(&t, &mut tm);
    }
    LocalTime { hour: tm[2], min: tm[1], mday: tm[3], mon: tm[4], wday: tm[6] }
}

pub fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0)
}

pub fn hm(ms: f64) -> String {
    let l = local(ms);
    format!("{:02}:{:02}", l.hour, l.min)
}
