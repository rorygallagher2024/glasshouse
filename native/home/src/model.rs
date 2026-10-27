//! What /api/home/* answers, as the view uses it.

use serde_json::{json, Map, Value};
use std::collections::HashMap;

fn s(v: &Value, k: &str) -> String {
    match v.get(k) {
        Some(Value::String(x)) => x.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}
fn os(v: &Value, k: &str) -> Option<String> {
    match v.get(k) {
        Some(Value::String(x)) if !x.is_empty() => Some(x.clone()),
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => None,
    }
}
fn list(v: &Value, k: &str) -> Vec<String> {
    v.get(k).and_then(|a| a.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default()
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Kind {
    App,
    Dev,
    Ch,
}

impl Kind {
    pub fn key(self) -> &'static str {
        match self {
            Kind::App => "app",
            Kind::Dev => "dev",
            Kind::Ch => "ch",
        }
    }
    pub fn from_key(k: &str) -> Option<Kind> {
        match k {
            "app" => Some(Kind::App),
            "dev" => Some(Kind::Dev),
            "ch" => Some(Kind::Ch),
            _ => None,
        }
    }
}

pub const LG_HOME_TILE: &str = "lg-home";

#[derive(Clone, Debug)]
pub struct Item {
    pub id: String,
    pub title: String,
    pub icon: Option<String>,
    pub lg: bool,
    // Inputs
    pub port: i64,
    pub via: Option<String>,
    pub address: Option<String>,
    pub unused: bool,
    // Channels
    pub number: String,
}

impl Item {
    pub fn blank(id: String, title: String) -> Item {
        Item { id, title, icon: None, lg: false, port: 0, via: None, address: None, unused: false, number: String::new() }
    }
}

#[derive(Clone, Debug, Default)]
pub struct Colours {
    pub text: u32,
    pub accent: u32,
}

#[derive(Clone, Debug)]
pub struct Layout {
    pub rows: Vec<Kind>,
    pub sort: HashMap<Kind, String>,
    pub hidden: HashMap<Kind, Vec<String>>,
    pub channels: Vec<String>,
    pub hint_seen: bool,
    pub picture: bool,
    pub colours: Option<Colours>,
}

fn hex(s: &str) -> Option<u32> {
    let s = s.strip_prefix('#')?;
    if s.len() != 6 {
        return None;
    }
    u32::from_str_radix(s, 16).ok()
}

impl Layout {
    pub fn parse(v: &Value) -> Layout {
        let mut rows: Vec<Kind> = list(v, "rows").iter().filter_map(|k| Kind::from_key(k)).collect();
        if rows.is_empty() {
            rows = vec![Kind::App, Kind::Dev, Kind::Ch];
        }
        let mut sort = HashMap::new();
        let mut hidden = HashMap::new();
        for k in [Kind::App, Kind::Dev, Kind::Ch] {
            if let Some(x) = v.get("sort").and_then(|o| o.get(k.key())).and_then(|x| x.as_str()) {
                sort.insert(k, x.to_string());
            }
            hidden.insert(k, v.get("hidden").map(|h| list(h, k.key())).unwrap_or_default());
        }
        let colours = v.get("colours").and_then(|c| Some(Colours { text: hex(c.get("text")?.as_str()?)?, accent: hex(c.get("accent")?.as_str()?)? }));
        Layout {
            rows,
            sort,
            hidden,
            channels: list(v, "channels"),
            hint_seen: v.get("hintSeen").and_then(|x| x.as_bool()).unwrap_or(false),
            picture: v.get("picture").and_then(|x| x.as_bool()) == Some(true),
            colours,
        }
    }

    pub fn sort_json(&self) -> Value {
        let mut m = Map::new();
        for (k, v) in &self.sort {
            m.insert(k.key().into(), json!(v));
        }
        Value::Object(m)
    }
    pub fn hidden_json(&self) -> Value {
        let mut m = Map::new();
        for k in [Kind::App, Kind::Dev, Kind::Ch] {
            m.insert(k.key().into(), json!(self.hidden.get(&k).cloned().unwrap_or_default()));
        }
        Value::Object(m)
    }
    pub fn rows_json(&self) -> Value {
        json!(self.rows.iter().map(|k| k.key()).collect::<Vec<_>>())
    }
}

#[derive(Clone, Debug)]
pub struct Wallpapers {
    pub available: bool,
    pub slots: Option<HashMap<String, bool>>,
    pub revision: String,
}

impl Wallpapers {
    pub fn parse(v: Option<&Value>) -> Wallpapers {
        let v = v.cloned().unwrap_or(Value::Null);
        let slots = v.get("slots").and_then(|s| s.as_object()).map(|o| o.iter().map(|(k, b)| (k.clone(), b.as_bool().unwrap_or(false))).collect());
        Wallpapers { available: v.get("available").and_then(|x| x.as_bool()).unwrap_or(false), slots, revision: s(&v, "revision") }
    }
}

pub struct Catalogue {
    pub apps: Vec<Item>,
    pub devices: Vec<Item>,
    pub channels: Vec<Item>,
    pub order: HashMap<Kind, Vec<String>>,
    pub tuned_channels: f64,
    pub layout: Layout,
    pub layout_version: Option<String>,
}

impl Catalogue {
    pub fn parse(v: &Value) -> Catalogue {
        let items = |k: &str| v.get(k).and_then(|a| a.as_array()).cloned().unwrap_or_default();
        let apps = items("apps")
            .iter()
            .map(|a| {
                let mut it = Item::blank(s(a, "id"), s(a, "title"));
                it.icon = os(a, "icon");
                it
            })
            .collect();
        let devices = items("devices")
            .iter()
            .map(|d| {
                let mut it = Item::blank(s(d, "id"), s(d, "name"));
                it.port = d.get("port").and_then(|p| p.as_i64()).unwrap_or(0);
                it.via = os(d, "via");
                it.address = os(d, "address");
                it.unused = d.get("unused").and_then(|x| x.as_bool()).unwrap_or(false);
                it
            })
            .collect();
        let channels = items("channels")
            .iter()
            .map(|c| {
                let mut it = Item::blank(s(c, "id"), s(c, "name"));
                it.number = s(c, "number");
                it
            })
            .collect();
        let mut order = HashMap::new();
        for k in [Kind::App, Kind::Dev, Kind::Ch] {
            order.insert(k, v.get("order").map(|o| list(o, k.key())).unwrap_or_default());
        }
        Catalogue {
            apps,
            devices,
            channels,
            order,
            tuned_channels: v.get("sources").and_then(|s| s.get("channels")).and_then(|c| c.as_f64()).unwrap_or(0.0),
            layout: Layout::parse(v.get("layout").unwrap_or(&Value::Null)),
            layout_version: os(v, "layoutVersion"),
        }
    }
}

/// What was last on: /api/home/now.
#[derive(Clone, Debug, Default)]
pub struct LastOn {
    pub kind: Option<String>,
    pub port: i64,
    pub title: Option<String>,
    pub app_id: Option<String>,
    pub channel_name: Option<String>,
    pub channel_number: Option<String>,
    pub programme: Option<String>,
}

impl LastOn {
    pub fn parse(v: &Value) -> LastOn {
        LastOn {
            kind: os(v, "kind"),
            port: v.get("port").and_then(|p| p.as_i64()).unwrap_or(0),
            title: os(v, "title"),
            app_id: os(v, "appId"),
            channel_name: v.get("channel").and_then(|c| os(c, "name")),
            channel_number: v.get("channel").and_then(|c| os(c, "number")),
            programme: v.get("programme").and_then(|p| os(p, "title")),
        }
    }
    pub fn has_channel(&self) -> bool {
        self.channel_name.is_some() || self.channel_number.is_some()
    }
}

#[derive(Clone, Debug)]
pub struct Signal {
    pub played: bool,
    pub width: String,
    pub height: String,
    pub hz: Option<f64>,
    pub chroma: Option<String>,
    pub bits: Option<String>,
    pub hdr: Option<String>,
    pub vrr: bool,
    pub allm: bool,
}

#[derive(Clone, Debug)]
pub struct Picture {
    pub signal: Option<Signal>,
    pub mode: Option<String>,
    pub light: Option<String>,
    pub oled: bool,
}

impl Picture {
    pub fn parse(v: &Value) -> Option<Picture> {
        if v.get("ok").and_then(|x| x.as_bool()) != Some(true) {
            return None;
        }
        let truthy = |x: Option<&Value>| match x {
            Some(Value::Bool(b)) => *b,
            Some(Value::Null) | None => false,
            Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0) != 0.0,
            Some(Value::String(s)) => !s.is_empty(),
            _ => true,
        };
        let signal = v.get("signal").filter(|s| s.is_object()).map(|s| Signal {
            played: truthy(s.get("played")),
            width: s.get("width").map(|x| x.to_string().trim_matches('"').to_string()).unwrap_or_default(),
            height: s.get("height").map(|x| x.to_string().trim_matches('"').to_string()).unwrap_or_default(),
            hz: s.get("hz").and_then(|x| x.as_f64()).filter(|h| *h != 0.0),
            chroma: os(s, "chroma"),
            bits: os(s, "bits"),
            hdr: os(s, "hdr"),
            vrr: truthy(s.get("vrr")),
            allm: truthy(s.get("allm")),
        });
        let light = match v.get("light") {
            Some(Value::Number(n)) => Some(n.to_string()),
            _ => None,
        };
        Some(Picture {
            signal,
            mode: v.get("mode").and_then(|m| os(m, "display")),
            light,
            oled: truthy(v.get("oled")),
        })
    }
}

#[derive(Clone, Debug)]
pub struct Show {
    pub title: String,
    pub start: f64,
    pub end: f64,
}

pub fn parse_guide(v: &Value) -> HashMap<String, Vec<Show>> {
    let mut out = HashMap::new();
    if let Some(o) = v.get("guide").and_then(|g| g.as_object()) {
        for (id, shows) in o {
            let list = shows
                .as_array()
                .map(|a| {
                    a.iter()
                        .map(|s| Show {
                            title: s.get("title").and_then(|t| t.as_str()).unwrap_or("").to_string(),
                            start: s.get("start").and_then(|x| x.as_f64()).unwrap_or(0.0),
                            end: s.get("end").and_then(|x| x.as_f64()).unwrap_or(0.0),
                        })
                        .collect()
                })
                .unwrap_or_default();
            out.insert(id.clone(), list);
        }
    }
    out
}

#[derive(Clone, Debug)]
pub struct RecentApp {
    pub id: String,
    pub title: String,
    pub image: bool,
}

pub fn parse_recents(v: &Value) -> Vec<RecentApp> {
    v.get("apps")
        .and_then(|a| a.as_array())
        .map(|a| {
            a.iter()
                .map(|r| RecentApp {
                    id: s(r, "id"),
                    title: s(r, "title"),
                    image: r.get("image").and_then(|x| x.as_bool()).unwrap_or(false),
                })
                .collect()
        })
        .unwrap_or_default()
}
