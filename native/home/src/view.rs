//! Glasshouse Home's view. Everything comes from /api/home/*: the layout
//! shared with the dashboard's Home tab, the TV's apps, CEC devices and
//! picked channels, and what was last on. Opening a tile goes back to the
//! server, which opens only what it listed. The behaviour and the geometry
//! follow the web view this replaces (assets/home.html before it): the same
//! keys, rows, timings and pixel positions on the 1920x1080 stage.

use crate::anim::{Tween, EASE, GLIDE};
use crate::api::{Api, Reply};
use crate::gfx::{self, Gfx, Rect, Rgba, Texture};
use crate::i18n::{self, I18n};
use crate::model::*;
use crate::text::{Face, Text};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

const LONG_PRESS_MS: f64 = 800.0;
const BEAT_MS: f64 = 5000.0;
const TOAST_MS: f64 = 3600.0;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Key {
    Left,
    Right,
    Up,
    Down,
    Ok,
    Back,
    Red,
    Yellow,
}

pub enum Tag {
    Catalogue { revision: u32, while_arranging: bool, then: Then },
    Now,
    Guide,
    Picture(u32),
    Beat,
    Open,
    Recents(u32),
    RecentAction(u32, &'static str),
    SaveLayout { stay: bool, saved: Option<(String, String)> },
    Reset,
    Fire,
    Icon(String),
    Wall { id: String, strength: f32, slot: String, revision: String },
    Shot(String, u64),
}

#[derive(Clone, Copy, PartialEq)]
pub enum Then {
    Nothing,
    AfterSaveStay,
    AfterReset,
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Hit {
    Tile(usize, i32),
    Sort(usize),
    Bar(usize),
    Card(usize, bool),
    CloseAll,
}

struct Palette {
    text: Rgba,
    mid: Rgba,
    low: Rgba,
    accent: Rgba,
    held: Rgba,
    focus: Rgba,
}

fn shade(c: u32, f: f32) -> Rgba {
    let r = (((c >> 16) & 255) as f32 * f).round() / 255.0;
    let g = (((c >> 8) & 255) as f32 * f).round() / 255.0;
    let b = ((c & 255) as f32 * f).round() / 255.0;
    Rgba(r, g, b, 1.0)
}

impl Palette {
    /// The dashboards' choice of text and accent colour: the quieter text and
    /// the held tile's tint are mixed toward black from the chosen colours, in
    /// the proportions the view's own have to #ece7df and #e9ad55, and focus is
    /// framed in the accent rather than the text colour.
    fn of(c: &Option<Colours>) -> Palette {
        match c {
            None => Palette {
                text: Rgba::hex(0xece7df),
                mid: Rgba::hex(0xa39d93),
                low: Rgba::hex(0x6b665e),
                accent: Rgba::hex(0xe9ad55),
                held: Rgba::hex(0x231d12),
                focus: Rgba::hex(0xece7df),
            },
            Some(c) => Palette {
                text: Rgba::hex(c.text),
                mid: shade(c.text, 0.69),
                low: shade(c.text, 0.45),
                accent: Rgba::hex(c.accent),
                held: shade(c.accent, 0.15),
                focus: Rgba::hex(c.accent),
            },
        }
    }
}

const BG_FOCUS: Rgba = Rgba(20.0 / 255.0, 19.0 / 255.0, 16.0 / 255.0, 0.86);
const LINE: u32 = 0x2a2825;
const PANEL: u32 = 0x141310;
const SHADOW: Rgba = Rgba(0.0, 0.0, 0.0, 0.55);

struct WallLayer {
    tex: Option<Texture>,
    opacity: Tween,
}

/// A wallpaper going up to the GPU a band per frame: 9 MB in one call held a
/// frame for tens of milliseconds as it started to fade in.
struct PendingWall {
    tex: Texture,
    px: Vec<u8>,
    row: u32,
    id: String,
    strength: f32,
}

const WALL_ROWS_PER_FRAME: u32 = 96;

struct Recents {
    open: bool,
    loading: bool,
    revision: u32,
    apps: Vec<RecentApp>,
    col: usize,
    on_x: bool,
    on_all: bool,
    busy: bool,
    stamp: u64,
    /// Snapshots kept between visits with the hash of their bytes, decoded
    /// again only when an app's has changed.
    shots: HashMap<String, (Texture, u64)>,
    slide: Tween,
    track: Tween,
}

pub struct View {
    pub api: Api<Tag>,
    i18n: I18n,
    data: Option<Catalogue>,
    layout: Option<Layout>,
    guide: HashMap<String, Vec<Show>>,
    last_on: LastOn,
    // Focus
    row: usize,
    col: HashMap<Kind, i32>,
    arranging: bool,
    held: bool,
    bar: i32,
    last: Option<(Kind, String)>,
    build: Option<String>,
    pub restart_for_build: bool,
    ok_down_at: f64,
    ok_long: bool,
    ok_in_recents: bool,
    back_down: bool,
    beat_fails: u32,
    layout_revision: u32,
    layout_busy: bool,
    layout_version: Option<String>,
    initial_escape: bool,
    wall_available: bool,
    wall_slots: Option<HashMap<String, bool>>,
    wall_revision: String,
    wall_shown: Option<String>,
    wall_front: usize,
    walls: [WallLayer; 2],
    pending_wall: Option<PendingWall>,
    preview_wall: Option<String>,
    preview_hour: Option<i32>,
    picture: Option<Picture>,
    picture_revision: u32,
    picture_source: Option<String>,
    moved_rows: HashSet<Kind>,
    channels_changed: bool,
    pending_saved: Option<(String, String)>,
    recents: Recents,
    toast: Option<(String, String)>,
    toast_until: f64,
    toast_anim: Tween,
    fault: bool,
    // Timers, in ms since the epoch.
    next_beat: f64,
    next_quarter: f64,
    next_minute: f64,
    next_load: f64,
    load_retry: f64,
    // Drawing
    tracks: HashMap<Kind, Tween>,
    focus_anim: HashMap<String, Tween>,
    held_anim: HashMap<String, Tween>,
    dim: Tween,
    icons: HashMap<String, Option<Texture>>,
    hits: Vec<(Rect, Hit)>,
    started: f64,
    pub visible: bool,
    reduced_motion: bool,
    /// Milliseconds the last frame spent on the wallpaper, the top strip and the rows.
    pub parts: [f64; 3],
}

impl View {
    pub fn new(api: Api<Tag>, i18n: I18n, preview_wall: Option<String>, preview_hour: Option<i32>, now: f64) -> View {
        View {
            api,
            i18n,
            data: None,
            layout: None,
            guide: HashMap::new(),
            last_on: LastOn::default(),
            row: 0,
            col: HashMap::new(),
            arranging: false,
            held: false,
            bar: -1,
            last: None,
            build: None,
            restart_for_build: false,
            ok_down_at: 0.0,
            ok_long: false,
            ok_in_recents: false,
            back_down: false,
            beat_fails: 0,
            layout_revision: 0,
            layout_busy: false,
            layout_version: None,
            initial_escape: false,
            wall_available: false,
            wall_slots: None,
            wall_revision: String::new(),
            wall_shown: None,
            wall_front: 0,
            walls: [WallLayer { tex: None, opacity: Tween::new(0.0) }, WallLayer { tex: None, opacity: Tween::new(0.0) }],
            pending_wall: None,
            preview_wall,
            preview_hour,
            picture: None,
            picture_revision: 0,
            picture_source: None,
            moved_rows: HashSet::new(),
            channels_changed: false,
            pending_saved: None,
            recents: Recents {
                open: false,
                loading: false,
                revision: 0,
                apps: Vec::new(),
                col: 0,
                on_x: false,
                on_all: false,
                busy: false,
                stamp: 0,
                shots: HashMap::new(),
                slide: Tween::new(0.0),
                track: Tween::new(0.0),
            },
            toast: None,
            toast_until: 0.0,
            toast_anim: Tween::new(0.0),
            fault: false,
            next_beat: now + BEAT_MS,
            next_quarter: now + 15000.0,
            next_minute: now + 60000.0,
            next_load: now + 300000.0,
            load_retry: 0.0,
            tracks: HashMap::new(),
            focus_anim: HashMap::new(),
            held_anim: HashMap::new(),
            dim: Tween::new(1.0),
            icons: HashMap::new(),
            hits: Vec::new(),
            started: now,
            visible: true,
            reduced_motion: false,
            parts: [0.0; 3],
        }
    }

    fn t(&self, key: &str, en: &str) -> String {
        self.i18n.t(key, en, &[])
    }
    fn tv(&self, key: &str, en: &str, vars: &[(&str, String)]) -> String {
        self.i18n.t(key, en, vars)
    }

    pub fn start(&mut self) {
        self.beat();
        self.load(false, Then::Nothing);
    }

    // ------------------------------------------------------------ items

    fn by_id(&self, kind: Kind, id: &str) -> Option<Item> {
        let data = self.data.as_ref()?;
        match kind {
            Kind::App => {
                if id == LG_HOME_TILE {
                    let mut it = Item::blank(LG_HOME_TILE.into(), self.t("home.lgHome", "LG Home"));
                    it.lg = true;
                    return Some(it);
                }
                data.apps.iter().find(|a| a.id == id).cloned()
            }
            Kind::Dev => data.devices.iter().find(|a| a.id == id).cloned(),
            Kind::Ch => data.channels.iter().find(|a| a.id == id).cloned(),
        }
    }

    fn hidden(&self, kind: Kind, id: &str) -> bool {
        self.layout.as_ref().and_then(|l| l.hidden.get(&kind)).map(|h| h.iter().any(|x| x == id)).unwrap_or(false)
    }

    fn by_recent(&self, kind: Kind) -> bool {
        self.layout.as_ref().and_then(|l| l.sort.get(&kind)).map(|s| s == "recent").unwrap_or(false)
    }

    /// A row's items in its saved order; arranging shows the hidden ones too.
    fn items(&self, kind: Kind) -> Vec<Item> {
        let mut out = Vec::new();
        if let Some(d) = &self.data {
            for id in d.order.get(&kind).map(|v| v.as_slice()).unwrap_or(&[]) {
                if let Some(it) = self.by_id(kind, id) {
                    if self.arranging || !self.hidden(kind, id) {
                        out.push(it);
                    }
                }
            }
        }
        out
    }

    fn rows(&self) -> Vec<Kind> {
        self.layout.as_ref().map(|l| l.rows.clone()).unwrap_or_default()
    }

    fn row_key(&self) -> Kind {
        self.rows().get(self.row).copied().unwrap_or(Kind::App)
    }

    /// A row with nothing to show is left out of the view, but not while arranging.
    fn shown(&self, ri: usize) -> bool {
        self.arranging || self.rows().get(ri).map(|k| !self.items(*k).is_empty()).unwrap_or(false)
    }

    /// The first shown row from ri on in direction dir, or ri where there is none.
    fn next_shown(&self, ri: i32, dir: i32) -> i32 {
        let n = self.rows().len() as i32;
        let mut i = ri;
        while i >= 0 && i < n {
            if self.shown(i as usize) {
                return i;
            }
            i += dir;
        }
        ri
    }

    /// -1, only while arranging, is the row's Order, left of its first tile.
    fn col_of(&self, kind: Kind) -> i32 {
        let c = *self.col.get(&kind).unwrap_or(&0);
        if self.arranging && c == -1 {
            return -1;
        }
        let n = self.items(kind).len() as i32;
        c.min(n - 1).max(0)
    }

    fn row_title(&self, kind: Kind) -> String {
        match kind {
            Kind::App => self.t("home.row.apps", "Apps"),
            Kind::Dev => self.t("home.row.inputs", "Inputs"),
            Kind::Ch => self.t("home.row.channels", "Channels"),
        }
    }

    fn sort_label(&self, kind: Kind) -> String {
        if self.by_recent(kind) {
            self.t("home.arrange.orderRecent", "Order: last opened")
        } else {
            self.t("home.arrange.orderCustom", "Order: yours")
        }
    }

    fn row_note(&self, kind: Kind, list: &[Item]) -> String {
        let data = self.data.as_ref().unwrap();
        match kind {
            Kind::App => self.tv(
                "home.row.appsNote",
                "{n} of {total} shown",
                &[("n", list.len().to_string()), ("total", data.order.get(&Kind::App).map(|o| o.len()).unwrap_or(0).to_string())],
            ),
            Kind::Dev => {
                let mut ports: Vec<i64> = Vec::new();
                for d in list {
                    if !d.unused && !ports.contains(&d.port) {
                        ports.push(d.port);
                    }
                }
                if ports.len() == 1 {
                    self.tv("home.row.inputsNoteOne", "Devices on HDMI {port}", &[("port", ports[0].to_string())])
                } else {
                    self.tv("home.row.inputsNote", "Devices on {n} HDMI inputs", &[("n", ports.len().to_string())])
                }
            }
            Kind::Ch => {
                if data.tuned_channels == 0.0 {
                    self.t("home.row.noTuner", "This TV has no channels tuned")
                } else if list.is_empty() {
                    self.t("home.row.addChannels", "Add channels in Glasshouse\u{2019}s Home settings")
                } else {
                    self.tv("home.row.channelsNote", "{n} added", &[("n", list.len().to_string())])
                }
            }
        }
    }

    // ------------------------------------------------------------ focus

    /// The web view's render(): what shows changes, scrolled in place.
    fn render(&mut self) {
        if self.layout.is_none() {
            return;
        }
        if !self.shown(self.row) {
            self.row = self.next_shown(0, 1).max(0) as usize;
        }
        self.apply_focus(true);
    }

    fn apply_focus(&mut self, instant: bool) {
        let rows = self.rows();
        for kind in rows.iter() {
            let c = self.col_of(*kind);
            self.scroll_track(*kind, c, instant);
        }
        if self.bar < 0 {
            let kind = self.row_key();
            let c = self.col_of(kind);
            self.last = if c >= 0 { self.items(kind).get(c as usize).map(|it| (kind, it.id.clone())) } else { None };
        }
    }

    fn tile_width(kind: Kind) -> f32 {
        match kind {
            Kind::App => 168.0,
            Kind::Dev => 380.0,
            Kind::Ch => 224.0,
        }
    }

    /// Keeps the focused tile in view by moving the track, so it stays between
    /// x 112 and 1808, as the web view did. The scroll is kept when the rows
    /// are drawn again: the web view rebuilt them and jumped back.
    fn scroll_track(&mut self, kind: Kind, col: i32, instant: bool) {
        let n = self.items(kind).len();
        if n == 0 {
            return;
        }
        let w = Self::tile_width(kind);
        let step = w + 8.0;
        let view_w = 1696.0;
        let c = col.max(0) as f32;
        let left = c * step;
        let tr = self.tracks.entry(kind).or_insert_with(|| Tween::new(0.0));
        let cur = tr.target();
        let mut x = cur;
        if left + w > cur + view_w {
            x = left + w - view_w;
        }
        if left < cur {
            x = left;
        }
        let scroll_w = (n as f32 * step).max(view_w);
        x = x.min(scroll_w - view_w).max(0.0);
        if instant || self.reduced_motion {
            tr.jump(x);
        } else {
            tr.set(x, i18n::now_ms() / 1000.0, 0.28, GLIDE);
        }
    }

    fn move_focus(&mut self, dr: i32, dc: i32) {
        let on_sort = self.col_of(self.row_key()) == -1;
        let nrows = self.rows().len() as i32;
        if dr != 0 {
            let to = self.next_shown(self.row as i32 + dr, dr);
            if to >= 0 && to < nrows && self.shown(to as usize) {
                self.row = to as usize;
            }
        }
        // Up and down from a row's Order go to the next row's.
        if dr != 0 && on_sort {
            let k = self.row_key();
            self.col.insert(k, -1);
        }
        if dc != 0 {
            let kind = self.row_key();
            let n = self.items(kind).len() as i32;
            let lo = if self.arranging { -1 } else { 0 };
            let c = (self.col_of(kind) + dc).min(n - 1).max(lo);
            self.col.insert(kind, c);
        }
        self.apply_focus(false);
    }

    // ------------------------------------------------------------ actions

    fn show_toast(&mut self, main: String, detail: String) {
        let now = i18n::now_ms();
        self.toast = Some((main, detail));
        self.toast_until = now + TOAST_MS;
        self.toast_anim.set(1.0, now / 1000.0, if self.reduced_motion { 0.0 } else { 0.2 }, EASE);
    }

    fn activate(&mut self) {
        let kind = self.row_key();
        let c = self.col_of(kind);
        if c < 0 {
            return;
        }
        if let Some(it) = self.items(kind).get(c as usize) {
            self.api.post(Tag::Open, "/api/home/open", json!({ "kind": kind.key(), "id": it.id }));
        }
    }

    // ------------------------------------------------------------ recent apps

    /// Back's panel: the TV's recent apps, newest first, as LG's Home shows
    /// them. Up from the cards is Close all; down from a card is its Close.
    /// Where the TV has no list, Back goes to the first tile.
    fn open_recents(&mut self) {
        if self.recents.busy {
            return;
        }
        self.recents.busy = true;
        self.recents.loading = true;
        self.recents.revision += 1;
        let r = self.recents.revision;
        self.api.get(Tag::Recents(r), "/api/home/recents");
    }

    fn close_recents(&mut self) {
        self.recents.revision += 1;
        self.recents.loading = false;
        if self.recents.open {
            self.recents.open = false;
            self.slide(false);
        }
    }

    fn slide(&mut self, open: bool) {
        let now = i18n::now_ms() / 1000.0;
        let d = if self.reduced_motion { 0.0 } else { 0.32 };
        self.recents.slide.set(if open { 1.0 } else { 0.0 }, now, d, GLIDE);
        self.dim.set(if open { 0.25 } else { 1.0 }, now, d, EASE);
    }

    fn show_recents(&mut self, apps: Vec<RecentApp>) {
        self.recents.apps = apps;
        self.recents.stamp = i18n::now_ms() as u64;
        let n = self.recents.apps.len();
        self.recents.col = self.recents.col.min(n.saturating_sub(1));
        if n == 0 {
            self.recents.on_x = false;
            self.recents.on_all = false;
        }
        let listed: HashSet<String> = self.recents.apps.iter().filter(|a| a.image).map(|a| a.id.clone()).collect();
        let gone: Vec<String> = self.recents.shots.keys().filter(|id| !listed.contains(*id)).cloned().collect();
        for id in gone {
            if let Some((t, _)) = self.recents.shots.remove(&id) {
                gfx::delete(&t);
            }
        }
        for a in &self.recents.apps {
            if a.image {
                let path = format!("/api/home/recents/image?id={}&v={}", enc(&a.id), self.recents.stamp);
                let known = self.recents.shots.get(&a.id).map(|s| s.1);
                self.api.image(Tag::Shot(a.id.clone(), self.recents.stamp), &path, 744, known);
            }
        }
        self.focus_recents(true);
    }

    fn focus_recents(&mut self, instant: bool) {
        if self.recents.apps.is_empty() {
            self.recents.track.jump(0.0);
            return;
        }
        let step = 372.0 + 32.0;
        let w = 372.0;
        let left = self.recents.col as f32 * step;
        let cur = self.recents.track.target();
        let mut x = cur;
        if left + w > cur + 1696.0 {
            x = left + w - 1696.0;
        }
        if left < cur {
            x = left;
        }
        let sw = (self.recents.apps.len() as f32 * step).max(1696.0);
        x = x.min(sw - 1696.0).max(0.0);
        if instant || self.reduced_motion {
            self.recents.track.jump(x);
        } else {
            self.recents.track.set(x, i18n::now_ms() / 1000.0, 0.28, GLIDE);
        }
    }

    fn recent_action(&mut self, action: &'static str, id: Option<String>) {
        if self.recents.busy {
            return;
        }
        self.recents.busy = true;
        let r = self.recents.revision;
        let mut body = json!({ "action": action });
        if let Some(id) = id {
            body["id"] = json!(id);
        }
        self.api.post(Tag::RecentAction(r, action), "/api/home/recents", body);
    }

    fn recents_key(&mut self, k: Key) {
        let app = self.recents.apps.get(self.recents.col).cloned();
        if k == Key::Back {
            return self.close_recents();
        }
        if self.recents.on_all {
            if k == Key::Ok {
                return self.recent_action("closeAll", None);
            }
            if k == Key::Down {
                self.recents.on_all = false;
            }
            return self.focus_recents(false);
        }
        let app = match app {
            Some(a) => a,
            None => return,
        };
        match k {
            Key::Left | Key::Right => {
                let n = self.recents.apps.len() as i32;
                let c = (self.recents.col as i32 + if k == Key::Left { -1 } else { 1 }).min(n - 1).max(0);
                self.recents.col = c as usize;
                self.recents.on_x = false;
            }
            Key::Up => {
                if self.recents.on_x {
                    self.recents.on_x = false;
                } else {
                    self.recents.on_all = true;
                }
            }
            Key::Down => self.recents.on_x = true,
            Key::Ok => return self.recent_action(if self.recents.on_x { "close" } else { "open" }, Some(app.id)),
            Key::Red => return self.recent_action("close", Some(app.id)),
            _ => {}
        }
        self.focus_recents(false);
    }

    // ------------------------------------------------------------ arranging

    /// Only the rows whose tiles were moved send their order: a row left alone
    /// keeps following its default, the Apps row most-used first. Saved while
    /// arranging (stay), the rows are read again, so a row set to Last opened
    /// shows that order.
    fn save_layout(&mut self, extra: Option<(&str, Value)>, stay: bool, saved: Option<(String, String)>) {
        self.layout_revision += 1;
        self.layout_busy = true;
        let (data, layout) = match (&self.data, &self.layout) {
            (Some(d), Some(l)) => (d, l),
            _ => return,
        };
        let mut order = serde_json::Map::new();
        for k in &self.moved_rows {
            order.insert(k.key().into(), json!(data.order.get(k).cloned().unwrap_or_default()));
        }
        let mut body = json!({
            "rows": layout.rows_json(),
            "order": Value::Object(order),
            "sort": layout.sort_json(),
            "hidden": layout.hidden_json(),
        });
        if self.channels_changed {
            body["channels"] = json!(layout.channels);
        }
        if let Some((k, v)) = extra {
            body[k] = v;
        }
        self.api.post(Tag::SaveLayout { stay, saved }, "/api/home/layout", body);
    }

    fn set_arranging(&mut self, on: bool) {
        if self.layout_busy {
            return;
        }
        self.layout_revision += 1;
        // The focus stays on the same item as hidden tiles appear or go.
        let kind = self.row_key();
        let c = self.col_of(kind);
        let cur = if c >= 0 { self.items(kind).get(c as usize).map(|i| i.id.clone()) } else { None };
        self.arranging = on;
        self.held = false;
        self.bar = -1;
        if let Some(id) = cur {
            if let Some(i) = self.items(kind).iter().position(|x| x.id == id) {
                self.col.insert(kind, i as i32);
            }
        }
        if !on {
            self.save_layout(None, false, None);
        }
        self.render();
    }

    /// Picking a tile up in a Last opened row puts the row in the order it
    /// shows, to be moved from there.
    fn pick_up(&mut self) {
        let kind = self.row_key();
        if self.col_of(kind) == -1 {
            return self.toggle_sort(kind);
        }
        if !self.held && !self.items(kind).is_empty() && self.by_recent(kind) {
            if let Some(l) = self.layout.as_mut() {
                l.sort.insert(kind, "custom".into());
            }
            self.moved_rows.insert(kind);
            let title = self.row_title(kind);
            let main = self.tv("home.arrange.nowCustom", "{row} are now in your order", &[("row", title)]);
            let detail = self.t("home.arrange.nowCustomDesc", "The row's Order, left of its first tile, puts them back in last opened order");
            self.show_toast(main, detail);
            self.render();
        }
        self.held = !self.held;
        self.apply_focus(false);
    }

    /// A row's Order: between its own order and last opened.
    fn toggle_sort(&mut self, kind: Kind) {
        if self.layout_busy {
            return;
        }
        self.held = false;
        let recent = !self.by_recent(kind);
        if let Some(l) = self.layout.as_mut() {
            l.sort.insert(kind, if recent { "recent" } else { "custom" }.into());
        }
        let row = self.row_title(kind);
        let toast = if recent {
            (
                self.tv("home.arrange.sortedRecent", "{row}: last opened first", &[("row", row)]),
                self.t("home.arrange.sortedRecentDesc", "Each tile moves to the front when it is opened"),
            )
        } else {
            (
                self.tv("home.arrange.sortedCustom", "{row}: in your order", &[("row", row)]),
                self.t("home.arrange.sortedCustomDesc", "Pick a tile up with OK to move it"),
            )
        };
        self.save_layout(None, true, Some(toast));
    }

    fn shift_tile(&mut self, dc: i32) {
        let kind = self.row_key();
        let list = self.items(kind);
        let i = self.col_of(kind);
        let j = i + dc;
        if i < 0 || j < 0 || j >= list.len() as i32 {
            return;
        }
        if let Some(order) = self.data.as_mut().and_then(|d| d.order.get_mut(&kind)) {
            let a = order.iter().position(|x| *x == list[i as usize].id);
            let b = order.iter().position(|x| *x == list[j as usize].id);
            if let (Some(a), Some(b)) = (a, b) {
                order.swap(a, b);
            }
        }
        self.moved_rows.insert(kind);
        self.col.insert(kind, j);
        self.render();
    }

    fn shift_row(&mut self, dr: i32) {
        let i = self.row as i32;
        let j = i + dr;
        let n = self.rows().len() as i32;
        if j < 0 || j >= n {
            return;
        }
        if let Some(l) = self.layout.as_mut() {
            l.rows.swap(i as usize, j as usize);
        }
        self.row = j as usize;
        self.render();
    }

    fn toggle_hidden(&mut self) {
        let (kind, id) = match self.last.clone() {
            Some(x) => x,
            None => return,
        };
        // The LG Home tile is the way back to LG's Home, so it always shows.
        if kind == Kind::App && id == LG_HOME_TILE {
            return;
        }
        if self.by_id(kind, &id).is_none() {
            return;
        }
        if kind == Kind::Ch {
            if let Some(l) = self.layout.as_mut() {
                l.channels.retain(|x| *x != id);
            }
            if let Some(o) = self.data.as_mut().and_then(|d| d.order.get_mut(&Kind::Ch)) {
                o.retain(|x| *x != id);
            }
            self.channels_changed = true;
            return self.render();
        }
        if let Some(h) = self.layout.as_mut().and_then(|l| l.hidden.get_mut(&kind)) {
            if let Some(i) = h.iter().position(|x| *x == id) {
                h.remove(i);
            } else {
                h.push(id);
            }
        }
        self.render();
    }

    fn reset_layout(&mut self) {
        if self.layout_busy {
            return;
        }
        self.layout_revision += 1;
        self.layout_busy = true;
        self.api.post(Tag::Reset, "/api/home/layout", json!({ "reset": true }));
    }

    fn press_bar(&mut self, b: i32) {
        match b {
            0 => {
                self.bar = -1;
                self.toggle_hidden();
            }
            1 => self.reset_layout(),
            _ => self.set_arranging(false),
        }
    }

    fn arrange_key(&mut self, k: Key) {
        if self.bar >= 0 {
            match k {
                Key::Left => self.bar = (self.bar - 1).max(0),
                Key::Right => self.bar = (self.bar + 1).min(2),
                Key::Up => self.bar = -1,
                Key::Ok => return self.press_bar(self.bar),
                _ => {}
            }
            return self.apply_focus(false);
        }
        match k {
            Key::Left => {
                if self.held { self.shift_tile(-1) } else { self.move_focus(0, -1) }
            }
            Key::Right => {
                if self.held { self.shift_tile(1) } else { self.move_focus(0, 1) }
            }
            Key::Up => {
                if self.held { self.shift_row(-1) } else { self.move_focus(-1, 0) }
            }
            Key::Down => {
                if self.held {
                    self.shift_row(1)
                } else if self.row + 1 == self.rows().len() {
                    self.bar = 0;
                    self.apply_focus(false);
                } else {
                    self.move_focus(1, 0)
                }
            }
            Key::Ok => self.pick_up(),
            Key::Red => self.toggle_hidden(),
            Key::Yellow => self.reset_layout(),
            _ => {}
        }
    }

    // ------------------------------------------------------------ input

    pub fn key_down(&mut self, k: Key, repeat: bool) {
        if self.data.is_none() || self.layout.is_none() || self.layout_busy {
            return;
        }
        let now = i18n::now_ms();
        if k == Key::Ok {
            // Acted on at release, unless held: a long press arranges.
            if self.ok_down_at > 0.0 || repeat {
                return;
            }
            self.ok_down_at = now;
            self.ok_long = false;
            self.ok_in_recents = self.recents.open;
            return;
        }
        if k == Key::Back {
            if self.back_down || repeat {
                return;
            }
            self.back_down = true;
            if self.recents.open || self.recents.loading {
                return self.close_recents();
            }
            if self.arranging && self.held {
                self.held = false;
                return self.toggle_hidden();
            }
            if self.arranging {
                return self.set_arranging(false);
            }
            return self.open_recents();
        }
        if self.recents.open {
            return self.recents_key(k);
        }
        if self.arranging {
            return self.arrange_key(k);
        }
        match k {
            Key::Left => self.move_focus(0, -1),
            Key::Right => self.move_focus(0, 1),
            Key::Up => self.move_focus(-1, 0),
            Key::Down => self.move_focus(1, 0),
            _ => {}
        }
    }

    pub fn key_up(&mut self, k: Key) {
        if k == Key::Back {
            self.back_down = false;
            return;
        }
        if k != Key::Ok || self.ok_down_at == 0.0 {
            return;
        }
        self.ok_down_at = 0.0;
        if self.ok_long || self.layout_busy {
            return;
        }
        if self.ok_in_recents {
            if self.recents.open {
                self.recents_key(Key::Ok);
            }
            return;
        }
        if self.recents.open || self.recents.loading {
            return;
        }
        if self.arranging {
            self.arrange_key(Key::Ok);
        } else {
            self.activate();
        }
    }

    fn hit_at(&self, x: f32, y: f32) -> Option<Hit> {
        self.hits.iter().rev().find(|(r, _)| r.contains(x, y)).map(|(_, h)| *h)
    }

    /// The Magic Remote's pointer: hovering focuses a tile.
    pub fn pointer(&mut self, x: f32, y: f32) {
        if self.layout_busy {
            return;
        }
        let hit = self.hit_at(x, y);
        if self.recents.open {
            if let Some(Hit::Card(i, _)) = hit {
                if i != self.recents.col || self.recents.on_all {
                    self.recents.col = i;
                    self.recents.on_all = false;
                    self.recents.on_x = false;
                    self.focus_recents(false);
                }
            }
            return;
        }
        if self.held {
            return;
        }
        if let Some(Hit::Tile(r, c)) = hit {
            let kind = self.rows()[r];
            if self.row != r || self.col_of(kind) != c || self.bar >= 0 {
                self.row = r;
                self.col.insert(kind, c);
                self.bar = -1;
                self.apply_focus(false);
            }
        }
    }

    /// A click: opens what it is on.
    pub fn click(&mut self, x: f32, y: f32) {
        if self.data.is_none() || self.layout.is_none() || self.layout_busy {
            return;
        }
        let hit = self.hit_at(x, y);
        if self.recents.open {
            match hit {
                Some(Hit::CloseAll) => self.recent_action("closeAll", None),
                Some(Hit::Card(i, on_x)) => {
                    self.recents.col = i;
                    let id = self.recents.apps.get(i).map(|a| a.id.clone());
                    self.recent_action(if on_x { "close" } else { "open" }, id);
                }
                _ => self.close_recents(),
            }
            return;
        }
        match hit {
            Some(Hit::Bar(b)) => self.press_bar(b as i32),
            Some(Hit::Sort(r)) if self.arranging => {
                self.row = r;
                let k = self.row_key();
                self.col.insert(k, -1);
                self.toggle_sort(k);
            }
            Some(Hit::Tile(row, col)) => {
                if !self.held {
                    self.row = row;
                    self.col.insert(self.row_key(), col);
                    self.bar = -1;
                    self.apply_focus(false);
                }
                if self.arranging {
                    self.pick_up()
                } else {
                    self.activate()
                }
            }
            _ => {}
        }
    }

    // ------------------------------------------------------------ the top strip

    /// The plate. An input's signal is read off its receiver, so it is there
    /// while Home is; an app's is the last video it played, noted by the
    /// server while it played. A channel has none, and shows the mode it gets
    /// in SDR; an app that has played nothing shows no plate.
    fn refresh_picture(&mut self) {
        self.picture_revision += 1;
        let rev = self.picture_revision;
        let mut kind = self.last_on.kind.clone().unwrap_or_default();
        if !self.layout.as_ref().map(|l| l.picture).unwrap_or(false) {
            kind.clear();
        }
        if kind != "input" && kind != "channel" && kind != "app" {
            self.picture_source = None;
            self.picture = None;
            return;
        }
        let which = match kind.as_str() {
            "input" => format!("&port={}", self.last_on.port),
            "app" => format!("&app={}", enc(self.last_on.app_id.as_deref().unwrap_or(""))),
            _ => String::new(),
        };
        let source = format!("{}{}", kind, which);
        if self.picture_source.as_deref() != Some(&source) {
            self.picture_source = Some(source);
            self.picture = None;
        }
        self.api.get(Tag::Picture(rev), &format!("/api/home/picture?kind={}{}", kind, which));
    }

    // ------------------------------------------------------------ wallpaper

    fn wall_slot(&self) -> (&'static str, f32) {
        // Strength is how far the picture shows through the black: lower at night.
        const SLOTS: [(&str, i32, f32); 5] =
            [("night", 0, 0.55), ("morning", 6, 0.7), ("afternoon", 11, 0.62), ("evening", 17, 0.72), ("night", 21, 0.65)];
        if let Some(w) = &self.preview_wall {
            for s in SLOTS.iter().skip(1) {
                if s.0 == w {
                    return (s.0, s.2);
                }
            }
        }
        let h = match self.preview_hour {
            Some(h) => h % 24,
            None => i18n::local(i18n::now_ms()).hour,
        };
        let mut slot = SLOTS[0];
        for s in SLOTS {
            if s.1 <= h {
                slot = s;
            }
        }
        (slot.0, slot.2)
    }

    fn update_wall(&mut self) {
        let (key, strength) = self.wall_slot();
        let missing = self.wall_slots.as_ref().map(|s| !s.get(key).copied().unwrap_or(false)).unwrap_or(false);
        if !self.wall_available || missing {
            for l in self.walls.iter_mut() {
                l.opacity.jump(0.0);
                if let Some(t) = l.tex.take() {
                    gfx::delete(&t);
                }
            }
            self.wall_shown = None;
            return;
        }
        let id = format!("{}@{}@{}", key, strength, self.wall_revision);
        if self.wall_shown.as_deref() == Some(&id) {
            return;
        }
        let path = format!("/api/home/wallpaper?slot={}&v={}", key, enc(&self.wall_revision));
        // The drawn layer is 106% of the stage, scaled up 4% more by the drift.
        self.api.image(Tag::Wall { id, strength, slot: key.into(), revision: self.wall_revision.clone() }, &path, 2048, None);
    }

    // ------------------------------------------------------------ data

    fn load(&mut self, while_arranging: bool, then: Then) {
        if (self.layout_busy || self.arranging) && !while_arranging {
            return;
        }
        self.api.get(Tag::Catalogue { revision: self.layout_revision, while_arranging, then }, "/api/home/catalogue");
        self.api.get(Tag::Now, "/api/home/now");
    }

    fn refresh_guide(&mut self) {
        if self.layout.as_ref().map(|l| l.channels.is_empty()).unwrap_or(true) {
            return;
        }
        self.api.get(Tag::Guide, "/api/home/guide");
    }

    /// The server watches for these: the view in front without them for ten
    /// seconds is taken to be broken, and LG's Home opens instead.
    fn beat(&mut self) {
        if self.data.is_none() || self.layout.is_none() {
            return;
        }
        // The process, for the server to hold sam's registration of it.
        // A desktop preview's PID belongs to another machine, not the TV.
        let pid = if cfg!(target_arch = "arm") { Some(std::process::id()) } else { None };
        self.api.post(Tag::Beat, "/api/home/beat", json!({ "pid": pid }));
    }

    fn take_wallpapers(&mut self, v: Option<&Value>) {
        let w = Wallpapers::parse(v);
        self.wall_available = w.available;
        self.wall_slots = w.slots;
        self.wall_revision = w.revision;
        self.update_wall();
    }

    /// Home opened again: as the web view's relaunch or visibility change.
    pub fn returned(&mut self, wall: Option<String>, hour: Option<i32>) {
        self.initial_escape = false;
        self.ok_down_at = 0.0;
        self.back_down = false;
        self.close_recents();
        self.recents.slide.jump(0.0);
        self.dim.jump(1.0);
        self.preview_wall = wall;
        self.preview_hour = hour;
        self.update_wall();
        self.row = 0;
        self.col.clear();
        self.bar = -1;
        if self.arranging {
            self.set_arranging(false);
        }
        self.render();
        self.beat();
        self.load(false, Then::Nothing);
    }

    pub fn reply(&mut self, tag: Tag, r: Reply) {
        let now = i18n::now_ms();
        match (tag, r) {
            (Tag::Catalogue { revision, while_arranging, then }, Reply::Json(j)) => {
                let ok = j.as_ref().and_then(|j| j.get("ok")).and_then(|x| x.as_bool()) == Some(true);
                if !ok {
                    if self.data.is_none() {
                        self.fault = true;
                        // A live HTTP server is not enough: Home needs its tiles and escape tile.
                        if self.visible && !self.initial_escape {
                            self.initial_escape = true;
                            self.api.post(Tag::Fire, "/api/home/open", json!({ "kind": "lg", "recovery": true }));
                        }
                        self.load_retry = now + 2000.0;
                    }
                    return self.after_load(then, false);
                }
                // A reply sent before arranging or saving must not replace local edits.
                if revision != self.layout_revision || ((self.layout_busy || self.arranging) && !while_arranging) {
                    return;
                }
                let j = j.unwrap();
                let first = self.data.is_none();
                let cat = Catalogue::parse(&j);
                self.layout = Some(cat.layout.clone());
                if let Some(v) = &cat.layout_version {
                    self.layout_version = Some(v.clone());
                }
                self.data = Some(cat);
                self.fault = false;
                self.load_retry = 0.0;
                self.refresh_picture();
                self.take_wallpapers(j.get("wallpapers"));
                self.fetch_icons();
                if !self.arranging {
                    self.render();
                }
                if first {
                    self.beat();
                }
                if !self.layout.as_ref().unwrap().hint_seen {
                    let main = self.t("home.hint.title", "Hold OK to arrange");
                    let detail = self.t("home.hint.desc", "Move or hide tiles and rows. LG's Home is the last tile in Apps.");
                    self.show_toast(main, detail);
                    self.api.post(Tag::Fire, "/api/home/layout", json!({ "hintSeen": true }));
                    self.layout.as_mut().unwrap().hint_seen = true;
                }
                self.refresh_guide();
                self.after_load(then, true);
            }
            (Tag::Now, Reply::Json(Some(j))) => {
                self.last_on = LastOn::parse(&j);
                self.refresh_picture();
                if self.data.is_some() && !self.arranging {
                    self.render();
                }
            }
            (Tag::Guide, Reply::Json(Some(j))) => {
                if j.get("guide").is_some() {
                    self.guide = parse_guide(&j);
                }
            }
            (Tag::Picture(rev), Reply::Json(j)) => {
                if rev == self.picture_revision {
                    self.picture = j.as_ref().and_then(Picture::parse);
                }
            }
            (Tag::Beat, Reply::Posted(p)) => {
                let j = p.filter(|(s, _)| *s >= 200 && *s < 300).map(|(_, j)| j);
                match j {
                    Some(j) if j.get("ok").and_then(|x| x.as_bool()) == Some(true) => {
                        self.beat_fails = 0;
                        self.take_wallpapers(j.get("wallpapers"));
                        self.fault = false;
                        let b = j.get("build").and_then(|x| x.as_str()).map(String::from);
                        // A new release of the server: the view is the old one's until restarted.
                        if let (Some(have), Some(b)) = (&self.build, &b) {
                            if have != b {
                                if !self.arranging && !self.layout_busy {
                                    self.restart_for_build = true;
                                }
                                return;
                            }
                        }
                        if b.is_some() {
                            self.build = b;
                        }
                        let lv = j.get("layoutVersion").and_then(|x| x.as_str()).map(String::from);
                        if let (Some(lv), Some(have)) = (lv, &self.layout_version) {
                            if &lv != have && !self.arranging && !self.layout_busy {
                                self.load(false, Then::Nothing);
                            }
                        }
                    }
                    _ => {
                        self.beat_fails += 1;
                        if self.beat_fails == 3 {
                            self.fault = true;
                        }
                    }
                }
            }
            (Tag::Open, Reply::Posted(p)) => {
                let ok = p.as_ref().and_then(|(_, j)| j.get("ok")).and_then(|x| x.as_bool()) == Some(true);
                if !ok {
                    let err = p.and_then(|(_, j)| j.get("error").and_then(|e| e.as_str()).map(String::from)).unwrap_or_default();
                    let main = self.t("home.openFailed", "That did not open");
                    self.show_toast(main, err);
                }
            }
            (Tag::Recents(rev), Reply::Json(j)) => {
                self.recents.busy = false;
                if rev != self.recents.revision {
                    return;
                }
                self.recents.loading = false;
                let ok = j.as_ref().and_then(|j| j.get("ok")).and_then(|x| x.as_bool()) == Some(true);
                if !ok {
                    self.row = self.next_shown(0, 1).max(0) as usize;
                    let k = self.row_key();
                    self.col.insert(k, 0);
                    return self.apply_focus(false);
                }
                self.recents.open = true;
                self.recents.col = 0;
                self.recents.on_x = false;
                self.recents.on_all = false;
                self.show_recents(parse_recents(j.as_ref().unwrap()));
                self.slide(true);
            }
            (Tag::RecentAction(rev, action), Reply::Posted(p)) => {
                self.recents.busy = false;
                if rev != self.recents.revision {
                    return;
                }
                let j = p.map(|(_, j)| j);
                let ok = j.as_ref().and_then(|j| j.get("ok")).and_then(|x| x.as_bool()) == Some(true);
                if !ok {
                    let err = j.and_then(|j| j.get("error").and_then(|e| e.as_str()).map(String::from)).unwrap_or_default();
                    let main = if action == "open" {
                        self.t("home.openFailed", "That did not open")
                    } else {
                        self.t("home.recents.closeFailed", "That did not close")
                    };
                    return self.show_toast(main, err);
                }
                if action == "open" {
                    return self.close_recents();
                }
                if action == "closeAll" {
                    self.close_recents();
                    let m = self.t("home.recents.allClosed", "Recent apps closed");
                    return self.show_toast(m, String::new());
                }
                self.show_recents(parse_recents(j.as_ref().unwrap()));
            }
            (Tag::SaveLayout { stay, saved }, Reply::Posted(p)) => {
                self.layout_revision += 1;
                let j = p.map(|(_, j)| j);
                let layout = j.as_ref().filter(|j| j.get("ok").and_then(|x| x.as_bool()) == Some(true)).and_then(|j| j.get("layout")).cloned();
                let layout = match layout {
                    Some(l) => l,
                    None => {
                        self.layout_busy = false;
                        let m = self.t("home.arrange.saveFailed", "Layout could not be saved");
                        return self.show_toast(m, String::new());
                    }
                };
                self.moved_rows.clear();
                self.channels_changed = false;
                self.layout = Some(Layout::parse(&layout));
                if !stay {
                    self.layout_busy = false;
                    let m = self.t("home.arrange.saved", "Layout saved");
                    let d = self.t("home.arrange.savedDesc", "The dashboard's Home tab shows it too");
                    self.show_toast(m, d);
                    return self.load(false, Then::Nothing);
                }
                // Keep edits blocked until the new order has arrived as well as the save.
                self.pending_saved = saved;
                self.load(true, Then::AfterSaveStay);
            }
            (Tag::Reset, Reply::Posted(p)) => {
                self.layout_busy = false;
                self.layout_revision += 1;
                let j = p.map(|(_, j)| j);
                let layout = j.as_ref().filter(|j| j.get("ok").and_then(|x| x.as_bool()) == Some(true)).and_then(|j| j.get("layout")).cloned();
                let layout = match layout {
                    Some(l) => l,
                    None => {
                        let m = self.t("home.arrange.resetFailed", "Layout could not be reset");
                        return self.show_toast(m, String::new());
                    }
                };
                self.moved_rows.clear();
                self.channels_changed = false;
                self.layout = Some(Layout::parse(&layout));
                self.row = 0;
                self.col.clear();
                self.held = false;
                self.load(true, Then::AfterReset);
            }
            (Tag::Icon(id), Reply::Image(d)) => {
                let t = d.map(|d| gfx::upload_rgba(d.w, d.h, &d.px, false));
                self.icons.insert(id, t);
            }
            (Tag::Shot(id, stamp), Reply::Image(d)) => {
                if stamp != self.recents.stamp {
                    return;
                }
                // A picture that cannot be had leaves the card its initial.
                if let Some((t, _)) = self.recents.shots.remove(&id) {
                    gfx::delete(&t);
                }
                if let Some(d) = d {
                    self.recents.shots.insert(id, (gfx::upload_rgba(d.w, d.h, &d.px, false), d.hash));
                }
            }
            (Tag::Wall { id, strength, slot, revision }, Reply::Image(d)) => {
                let d = match d {
                    Some(d) => d,
                    None => return,
                };
                if !self.wall_available || self.wall_revision != revision || self.wall_slot().0 != slot {
                    return;
                }
                if let Some(p) = self.pending_wall.take() {
                    gfx::delete(&p.tex);
                }
                self.pending_wall = Some(PendingWall { tex: gfx::alloc_rgba(d.w, d.h), px: d.px, row: 0, id, strength });
            }
            _ => {}
        }
    }

    /// The next band of a wallpaper on its way up; once all of it is there,
    /// it fades in over the one before.
    fn upload_wall(&mut self) {
        let done = match self.pending_wall.as_mut() {
            None => return,
            Some(p) => {
                let rows = WALL_ROWS_PER_FRAME.min(p.tex.h - p.row);
                gfx::upload_rows(&p.tex, &p.px, p.row, rows);
                p.row += rows;
                p.row >= p.tex.h
            }
        };
        if !done {
            return;
        }
        let p = self.pending_wall.take().unwrap();
        self.wall_shown = Some(p.id);
        let s = i18n::now_ms() / 1000.0;
        let next = 1 - self.wall_front;
        if let Some(t) = self.walls[next].tex.take() {
            gfx::delete(&t);
        }
        self.walls[next].tex = Some(p.tex);
        let fade = if self.reduced_motion { 0.0 } else { 2.4 };
        self.walls[next].opacity.set(p.strength, s, fade, EASE);
        self.walls[self.wall_front].opacity.set(0.0, s, fade, EASE);
        self.wall_front = next;
    }

    fn after_load(&mut self, then: Then, loaded: bool) {
        match then {
            Then::Nothing => {}
            Then::AfterSaveStay => {
                self.layout_busy = false;
                self.render();
                if loaded {
                    if let Some((m, d)) = self.pending_saved.take() {
                        self.show_toast(m, d);
                    }
                }
            }
            Then::AfterReset => {
                self.render();
                let m = self.t("home.arrange.resetDone", "Layout reset");
                let d = self.t("home.arrange.resetDesc", "Apps, Inputs, then Channels, in their first order");
                self.show_toast(m, d);
            }
        }
    }

    fn fetch_icons(&mut self) {
        let wanted: Vec<(String, String)> = self
            .data
            .as_ref()
            .map(|d| d.apps.iter().filter_map(|a| a.icon.as_ref().map(|i| (a.id.clone(), i.clone()))).collect())
            .unwrap_or_default();
        for (id, path) in wanted {
            if self.icons.contains_key(&id) {
                continue;
            }
            self.icons.insert(id.clone(), None);
            self.api.image(Tag::Icon(id), &path, 224, None);
        }
    }

    /// Timers; true while something on screen is moving.
    pub fn tick(&mut self) {
        let now = i18n::now_ms();
        if self.ok_down_at > 0.0 && !self.ok_long && !self.ok_in_recents && now - self.ok_down_at >= LONG_PRESS_MS {
            self.ok_long = true;
            if !self.held {
                let on = !self.arranging;
                self.set_arranging(on);
            }
        }
        if self.toast.is_some() && now >= self.toast_until && self.toast_anim.target() > 0.0 {
            self.toast_anim.set(0.0, now / 1000.0, if self.reduced_motion { 0.0 } else { 0.2 }, EASE);
        }
        if now >= self.next_beat {
            self.next_beat = now + BEAT_MS;
            self.beat();
        }
        if now >= self.next_quarter {
            self.next_quarter = now + 15000.0;
            self.update_wall();
            if self.visible {
                self.refresh_picture();
            }
        }
        if now >= self.next_minute {
            self.next_minute = now + 60000.0;
            self.api.get(Tag::Now, "/api/home/now");
            self.refresh_guide();
        }
        if now >= self.next_load {
            self.next_load = now + 300000.0;
            if !self.arranging {
                self.load(false, Then::Nothing);
            }
        }
        if self.load_retry > 0.0 && now >= self.load_retry {
            self.load_retry = 0.0;
            if self.visible {
                self.load(false, Then::Nothing);
            }
        }
    }

    /// Milliseconds until the next timer, for the event loop's wait.
    pub fn next_timer_ms(&self) -> f64 {
        let now = i18n::now_ms();
        let mut t = [self.next_beat, self.next_quarter, self.next_minute, self.next_load]
            .iter()
            .fold(f64::MAX, |a, b| a.min(*b));
        if self.load_retry > 0.0 {
            t = t.min(self.load_retry);
        }
        if self.ok_down_at > 0.0 && !self.ok_long {
            t = t.min(self.ok_down_at + LONG_PRESS_MS);
        }
        if self.toast.is_some() && self.toast_anim.target() > 0.0 {
            t = t.min(self.toast_until);
        }
        // The clock's next minute.
        let to_minute = 60000.0 - (now % 60000.0);
        (t - now).min(to_minute).max(0.0)
    }

    /// Whether a transition is running, so the next frame is wanted at once.
    pub fn animating(&self) -> bool {
        let s = i18n::now_ms() / 1000.0;
        self.tracks.values().any(|t| t.moving(s))
            || self.focus_anim.values().any(|t| t.moving(s))
            || self.held_anim.values().any(|t| t.moving(s))
            || self.recents.slide.moving(s)
            || self.recents.track.moving(s)
            || self.dim.moving(s)
            || self.toast_anim.moving(s)
            || self.walls.iter().any(|w| w.opacity.moving(s))
            || self.pending_wall.is_some()
    }

    /// Whether a wallpaper is drifting, which wants a frame now and then.
    pub fn drifting(&self) -> bool {
        !self.reduced_motion && self.walls.iter().any(|w| w.tex.is_some() && w.opacity.value(i18n::now_ms() / 1000.0) > 0.0)
    }

    // ------------------------------------------------------------ drawing

    pub fn draw(&mut self, g: &mut Gfx, tx: &mut Text) {
        let now = i18n::now_ms();
        let s = now / 1000.0;
        self.hits.clear();
        tx.reset_if_full();
        self.upload_wall();
        let pal = Palette::of(&self.layout.as_ref().and_then(|l| l.colours.clone()));

        let t0 = i18n::now_ms();
        self.draw_wall(g, s);
        let t1 = i18n::now_ms();
        let dim = self.dim.value(s);
        self.draw_now(g, tx, &pal, dim, now);
        let t2 = i18n::now_ms();
        if self.layout.is_some() && self.data.is_some() {
            self.draw_rows(g, tx, &pal, dim, s);
        }
        let t3 = i18n::now_ms();
        self.parts = [t1 - t0, t2 - t1, t3 - t2];
        g.clip(None);
        if self.arranging {
            self.draw_banner(g, tx, &pal);
        }
        self.draw_toast(g, tx, &pal, s);
        self.draw_recents(g, tx, &pal, s);
        if self.fault {
            self.draw_fault(g, tx, &pal);
        }
    }

    fn draw_wall(&mut self, g: &mut Gfx, s: f64) {
        // The layer is the stage grown 3% each way, the picture covering it,
        // and drifts over 180 s, back and forth: scale(1 to 1.04) then
        // translate(0 to -1.2%, -0.8%), about the layer's centre.
        let lw = 1920.0 * 1.06;
        let lh = 1080.0 * 1.06;
        let (lx, ly) = (-57.6f32, -32.4f32);
        let p = {
            let t = ((s - self.started / 1000.0) / 180.0) as f32;
            let cycle = t.rem_euclid(2.0);
            let x = if cycle > 1.0 { 2.0 - cycle } else { cycle };
            if self.reduced_motion { 0.0 } else { crate::anim::EASE_IN_OUT.at(x) }
        };
        let scale = 1.0 + 0.04 * p;
        let (tx_, ty_) = (-0.012 * lw * p, -0.008 * lh * p);
        let (cx, cy) = (lx + lw / 2.0, ly + lh / 2.0);
        for i in 0..2 {
            let op = self.walls[i].opacity.value(s);
            let tex = match self.walls[i].tex {
                Some(t) => t,
                None => continue,
            };
            if op <= 0.0 {
                continue;
            }
            // background-size: cover over the layer.
            let k = (lw / tex.w as f32).max(lh / tex.h as f32);
            let (iw, ih) = (tex.w as f32 * k, tex.h as f32 * k);
            let ix = lx + (lw - iw) / 2.0;
            let iy = ly + (lh - ih) / 2.0;
            // The layer's transform applied to the picture's corners.
            let x0 = cx + ((ix - cx) + tx_) * scale;
            let y0 = cy + ((iy - cy) + ty_) * scale;
            // The scrim keeps the text side and the rows dark: drawn with the
            // picture, as black over black changes nothing elsewhere.
            g.scrimmed(&tex, Rect::new(x0, y0, iw * scale, ih * scale), op);
        }
    }

    fn text_line(
        &mut self,
        g: &mut Gfx,
        tx: &mut Text,
        s: &str,
        face: Face,
        px: f32,
        ls: f32,
        x: f32,
        baseline: f32,
        c: Rgba,
        shadow: f32,
    ) -> f32 {
        if s.is_empty() {
            return 0.0;
        }
        let run = tx.run(s, face, px, ls);
        if shadow > 0.0 {
            tx.draw_shadow(g, &run, x, baseline, SHADOW.a(shadow));
        }
        tx.draw(g, &run, x, baseline, c);
        run.width
    }

    fn draw_now(&mut self, g: &mut Gfx, tx: &mut Text, pal: &Palette, dim: f32, now: f64) {
        // #now: 262px high, its three parts aligned to its bottom.
        let lt = i18n::local(now);
        let clock = format!("{:02}:{:02}", lt.hour, lt.min);
        let date = self.tv(
            "home.date",
            "{weekday} {day} {month}",
            &[("weekday", self.i18n.weekday(lt.wday as usize).into()), ("day", lt.mday.to_string()), ("month", self.i18n.month(lt.mon as usize).into())],
        );
        let sh = dim;
        let m_clock = tx.metrics(Face::OutfitLight, 176.0);
        let m_date = tx.metrics(Face::Manrope, 28.0);
        let clock_line = 176.0 * 0.8;
        let when_top = 262.0 - (clock_line + 22.0 + m_date.normal());
        self.text_line(g, tx, &clock, Face::OutfitLight, 176.0, -4.0, 112.0, when_top + m_clock.baseline_in(clock_line), pal.text.a(dim), sh);
        self.text_line(g, tx, &date, Face::Manrope, 28.0, 0.0, 112.0, when_top + clock_line + 22.0 + m_date.baseline_in(m_date.normal()), pal.mid.a(dim), sh);

        // What was last on.
        let lo = self.last_on.clone();
        let (kind, title, via) = match lo.kind.as_deref() {
            Some("input") => (
                self.t("home.now.lastWatched", "Last watched"),
                lo.title.clone().unwrap_or_else(|| self.tv("home.dev.port", "HDMI {port}", &[("port", lo.port.to_string())])),
                self.tv("home.dev.port", "HDMI {port}", &[("port", lo.port.to_string())]),
            ),
            Some("channel") if lo.has_channel() => (
                self.t("home.now.lastWatched", "Last watched"),
                lo.channel_name.clone().unwrap_or_default(),
                match &lo.programme {
                    Some(p) => self.tv(
                        "home.now.channelShow",
                        "Channel {number}: {title}",
                        &[("number", lo.channel_number.clone().unwrap_or_default()), ("title", p.clone())],
                    ),
                    None => self.tv("home.now.channel", "Channel {number}", &[("number", lo.channel_number.clone().unwrap_or_default())]),
                },
            ),
            Some("app") if lo.title.is_some() => (
                self.t("home.now.lastOpened", "Last opened"),
                lo.title.clone().unwrap_or_default(),
                self.t("home.now.app", "App on this TV"),
            ),
            _ => (String::new(), String::new(), String::new()),
        };

        // The plate, right-aligned, and how much of the row it takes.
        let plate = self.plate_lines();
        let mut plate_w = 0.0f32;
        if let Some((sig, mode, strip)) = &plate {
            let mut w = 0.0;
            for (i, part) in sig.iter().enumerate() {
                w += tx.width(part, Face::Manrope, 23.0, 0.0) + if i > 0 { 22.0 } else { 0.0 };
            }
            plate_w = plate_w.max(w);
            if !mode.is_empty() {
                plate_w = plate_w.max(tx.width(mode, Face::Outfit, 52.0, -0.5));
            }
            if let Some((label, value)) = strip {
                plate_w = plate_w.max(tx.width(label, Face::Manrope, 23.0, 0.0) + 12.0 + tx.width(value, Face::Manrope, 23.0, 0.0));
            }
            plate_w = plate_w.min(640.0);
        }
        let source_w = 1920.0 - 224.0 - 520.0 - if plate.is_some() { plate_w + 56.0 } else { 0.0 };
        if !title.is_empty() {
            let m23 = tx.metrics(Face::Manrope, 23.0);
            let m70 = tx.metrics(Face::Outfit, 70.0);
            let m26 = tx.metrics(Face::Manrope, 26.0);
            let h = m23.normal() + 8.0 + 70.0 + 12.0 + m26.normal() + 2.0;
            let top = 262.0 - h;
            let x = 632.0;
            g.fill(Rect::new(x, top, 1.0, h), 0.0, Rgba::hex(LINE).a(dim));
            let cx = x + 25.0;
            let cw = (source_w - 25.0).max(0.0);
            let k = tx.ellipsize(&kind, Face::Manrope, 23.0, 0.0, cw);
            self.text_line(g, tx, &k, Face::Manrope, 23.0, 0.0, cx, top + m23.baseline_in(m23.normal()), pal.accent.a(dim), sh);
            let tt = tx.ellipsize(&title, Face::Outfit, 70.0, -1.0, cw);
            self.text_line(g, tx, &tt, Face::Outfit, 70.0, -1.0, cx, top + m23.normal() + 8.0 + m70.baseline_in(70.0), pal.text.a(dim), sh);
            let v = tx.ellipsize(&via, Face::Manrope, 26.0, 0.0, cw);
            self.text_line(g, tx, &v, Face::Manrope, 26.0, 0.0, cx, top + m23.normal() + 90.0 + m26.baseline_in(m26.normal()), pal.mid.a(dim), sh);
        }
        if let Some((sig, mode, strip)) = plate {
            let right = 1808.0;
            let top = 262.0 - 162.0;
            let m23 = tx.metrics(Face::Manrope, 23.0);
            let m52 = tx.metrics(Face::Outfit, 52.0);
            // Signal parts, right to left.
            let parts: Vec<String> = sig.iter().map(|p| tx.ellipsize(p, Face::Manrope, 23.0, 0.0, plate_w)).collect();
            let total: f32 = parts.iter().enumerate().map(|(i, p)| tx.width(p, Face::Manrope, 23.0, 0.0) + if i > 0 { 22.0 } else { 0.0 }).sum();
            if total > 0.0 {
                let mut x = right - total;
                for (i, p) in parts.iter().enumerate() {
                    if i > 0 {
                        x += 22.0;
                    }
                    x += self.text_line(g, tx, p, Face::Manrope, 23.0, 0.0, x, top + m23.baseline_in(32.0), pal.mid.a(dim), sh);
                }
            }
            if !mode.is_empty() {
                let m = tx.ellipsize(&mode, Face::Outfit, 52.0, -0.5, plate_w);
                let w = tx.width(&m, Face::Outfit, 52.0, -0.5);
                self.text_line(g, tx, &m, Face::Outfit, 52.0, -0.5, right - w, top + 32.0 + 15.0 + m52.baseline_in(70.0), pal.text.a(dim), sh);
            }
            if let Some((label, value)) = strip {
                let base = top + 32.0 + 90.0 + m23.baseline_in(38.0);
                let vw = tx.width(&value, Face::Manrope, 23.0, 0.0);
                let lw = tx.width(&label, Face::Manrope, 23.0, 0.0);
                self.text_line(g, tx, &label, Face::Manrope, 23.0, 0.0, right - vw - 12.0 - lw, base, pal.low.a(dim), sh);
                self.text_line(g, tx, &value, Face::Manrope, 23.0, 0.0, right - vw, base, pal.mid.a(dim), sh);
            }
        }
    }

    /// The plate's three lines, or None where it does not show.
    #[allow(clippy::type_complexity)]
    fn plate_lines(&self) -> Option<(Vec<String>, String, Option<(String, String)>)> {
        let p = self.picture.as_ref()?;
        let is_input = self.last_on.kind.as_deref() == Some("input");
        if !(p.signal.is_some() || p.mode.is_some() || is_input) {
            return None;
        }
        let mut sig = Vec::new();
        if let Some(s) = &p.signal {
            // An app's video, noted while it played: it has stopped since.
            if s.played {
                sig.push(self.t("home.plate.played", "Last video"));
            }
            sig.push(match s.hz {
                Some(hz) => self.tv(
                    "home.plate.size",
                    "{width} \u{00d7} {height} at {hz} Hz",
                    &[("width", s.width.clone()), ("height", s.height.clone()), ("hz", fmt_hz(hz))],
                ),
                None => self.tv("home.plate.sizeOnly", "{width} \u{00d7} {height}", &[("width", s.width.clone()), ("height", s.height.clone())]),
            });
            if let Some(ch) = &s.chroma {
                sig.push(match &s.bits {
                    Some(b) => self.tv(
                        "home.plate.depth",
                        "{chroma}, {bits}-bit",
                        &[("chroma", ch.strip_prefix("YCbCr ").unwrap_or(ch).to_string()), ("bits", b.clone())],
                    ),
                    None => ch.clone(),
                });
            }
            match s.hdr.as_deref() {
                Some("hdr10") => sig.push("HDR10".into()),
                Some("hlg") => sig.push("HLG".into()),
                Some("dolby_vision") => sig.push(self.t("home.plate.dolby", "Dolby Vision")),
                _ => {}
            }
            if s.vrr {
                sig.push(self.t("home.plate.vrr", "VRR"));
            }
            if s.allm {
                sig.push(self.t("home.plate.allm", "Low latency"));
            }
        } else if is_input {
            sig.push(self.t("home.plate.noSignal", "No picture coming in"));
        }
        let strip = match (&p.mode, &p.light) {
            (Some(_), Some(l)) => Some((
                if p.oled { self.t("home.plate.oledLight", "OLED light") } else { self.t("home.plate.backlight", "Backlight") },
                l.clone(),
            )),
            _ => None,
        };
        Some((sig, p.mode.clone().unwrap_or_default(), strip))
    }

    fn tile_height(&self, tx: &Text, kind: Kind) -> f32 {
        match kind {
            Kind::App => 14.0 + 112.0 + 12.0 + tx.metrics(Face::ManropeSemi, 21.0).normal() + 14.0,
            Kind::Dev => 124.0,
            Kind::Ch => 176.0,
        }
    }

    fn tile_opacity(&self, kind: Kind, it: &Item, active: bool, focus: bool) -> f32 {
        let hidden = self.hidden(kind, &it.id);
        if hidden {
            return if focus { 0.5 } else { 0.22 };
        }
        if kind == Kind::Dev && it.unused {
            return if focus { 0.6 } else { 0.3 };
        }
        if focus {
            1.0
        } else if active {
            0.8
        } else {
            0.58
        }
    }

    fn draw_rows(&mut self, g: &mut Gfx, tx: &mut Text, pal: &Palette, dim: f32, s: f64) {
        let rows = self.rows();
        let m25 = tx.metrics(Face::Manrope, 25.0);
        let h2 = m25.normal();
        // Heights first: the rows sit centred between y 296 and 1040.
        let mut heights = Vec::new();
        let mut lists = Vec::new();
        for (ri, kind) in rows.iter().enumerate() {
            let list = self.items(*kind);
            let shown = !list.is_empty() || self.arranging;
            let body = if list.is_empty() { 64.0 } else { 6.0 + self.tile_height(tx, *kind) + 6.0 };
            heights.push(if shown { h2 + 10.0 + body + 22.0 } else { 0.0 });
            lists.push(list);
            let _ = ri;
        }
        let total: f32 = heights.iter().sum();
        let mut y = 296.0 + ((744.0 - total) / 2.0).max(0.0);
        let recents_open = self.recents.open || self.recents.slide.value(s) > 0.0;
        for (ri, kind) in rows.iter().enumerate() {
            if heights[ri] == 0.0 {
                continue;
            }
            let list = &lists[ri];
            let active = ri == self.row && self.bar < 0;
            let top = y;
            y += heights[ri];
            // The heading, its note, and while arranging the row's Order.
            let base = top + m25.baseline_in(h2);
            let title = self.row_title(*kind);
            let tcol = if self.arranging && active && self.held { pal.accent } else if self.arranging { pal.text } else { pal.mid };
            let mut x = 112.0;
            x += self.text_line(g, tx, &title, Face::Manrope, 25.0, 0.0, x, base, tcol.a(dim), dim);
            if !list.is_empty() {
                let note = self.row_note(*kind, list);
                x += 14.0;
                x += self.text_line(g, tx, &note, Face::Manrope, 25.0, 0.0, x, base, pal.low.a(dim), dim);
            }
            if self.arranging {
                let label = self.sort_label(*kind);
                let m20 = tx.metrics(Face::Manrope, 20.0);
                let w = tx.width(&label, Face::Manrope, 20.0, 0.0) + 28.0;
                let bh = m20.normal() + 8.0;
                let bx = x + 22.0;
                // inline-block, its baseline 2px above the heading's.
                let bb = base - 2.0;
                let by = bb - 4.0 - m20.baseline_in(m20.normal());
                let focus = active && self.col_of(*kind) == -1;
                let r = Rect::new(bx, by, w, bh);
                g.fill(r, 5.0, Rgba::hex(PANEL).a(dim));
                if focus {
                    g.outline(r, 5.0, 2.0, 0.0, pal.accent.a(dim));
                }
                self.text_line(g, tx, &label, Face::Manrope, 20.0, 0.0, bx + 14.0, bb, if focus { pal.text } else { pal.mid }.a(dim), dim);
                self.hits.push((r, Hit::Sort(ri)));
            }
            let body_top = top + h2 + 10.0;
            if list.is_empty() {
                // While arranging an empty row stands as a slot that can still be moved.
                let r = Rect::new(112.0, body_top, 1696.0, 64.0);
                let note = self.row_note(*kind, list);
                let held_row = active && self.held;
                if held_row {
                    g.fill(r, 6.0, pal.held.a(dim));
                }
                let (bc, dash) = if active && !held_row { (pal.accent, 0.0) } else if held_row { (pal.accent, 6.0) } else { (Rgba::hex(LINE), 6.0) };
                g.stroke(r, 6.0, 2.0, bc.a(dim), dash);
                let m21 = tx.metrics(Face::Manrope, 21.0);
                self.text_line(g, tx, &note, Face::Manrope, 21.0, 0.0, 136.0, body_top + 2.0 + m21.baseline_in(60.0), if active { pal.text } else { pal.low }.a(dim), 0.0);
                continue;
            }
            let th = self.tile_height(tx, *kind);
            let ty = body_top + 6.0;
            let w = Self::tile_width(*kind);
            let scroll = self.tracks.get(kind).map(|t| t.value(s)).unwrap_or(0.0);
            g.clip(Some(Rect::new(90.0, body_top, 1740.0, th + 12.0)));
            let c = self.col_of(*kind);
            for (ci, it) in list.iter().enumerate() {
                let tx0 = 112.0 + ci as f32 * (w + 8.0) - scroll;
                if tx0 + w < 80.0 || tx0 > 1840.0 {
                    continue;
                }
                let focus = active && ci as i32 == c && !recents_open;
                let key = format!("{}:{}", kind.key(), it.id);
                let fa = {
                    let t = self.focus_anim.entry(key.clone()).or_insert_with(|| Tween::new(0.0));
                    t.set(if focus { 1.0 } else { 0.0 }, s, if self.reduced_motion { 0.0 } else { 0.12 }, EASE);
                    t.value(s)
                };
                let held = focus && self.held && self.arranging;
                let ha = {
                    let t = self.held_anim.entry(key).or_insert_with(|| Tween::new(0.0));
                    t.set(if held { 1.0 } else { 0.0 }, s, if self.reduced_motion { 0.0 } else { 0.12 }, EASE);
                    t.value(s)
                };
                let op = self.tile_opacity(*kind, it, active, active && ci as i32 == c) * dim;
                let r = Rect::new(tx0, ty - 8.0 * ha, w, th);
                // While recent apps are open the focused tile shows no frame.
                let outline_c = if self.arranging { pal.accent } else { pal.focus };
                if held {
                    g.fill(r, 6.0, pal.held.a(op));
                    g.stroke(r.inset(-2.0), 8.0, 2.0, pal.accent.a(op), 6.0);
                } else {
                    g.fill(r, 6.0, BG_FOCUS.a(fa * op));
                    g.outline(r, 6.0, 2.0, 0.0, outline_c.a(fa * op));
                }
                self.draw_tile(g, tx, pal, *kind, it, r, op, focus);
                if self.hidden(*kind, &it.id) {
                    let label = self.t("home.hidden", "Hidden");
                    let m18 = tx.metrics(Face::Manrope, 18.0);
                    let lw = tx.width(&label, Face::Manrope, 18.0, 0.0) + 20.0;
                    let lh = m18.normal() + 6.0;
                    let lr = Rect::new(r.x + (w - lw) / 2.0, r.y + (th - lh) / 2.0, lw, lh);
                    g.fill(lr, 4.0, Rgba(0.0, 0.0, 0.0, op));
                    self.text_line(g, tx, &label, Face::Manrope, 18.0, 0.0, lr.x + 10.0, lr.y + 3.0 + m18.baseline_in(m18.normal()), pal.text.a(op), op);
                }
                self.hits.push((Rect::new(tx0.max(90.0), ty, (tx0 + w).min(1830.0) - tx0.max(90.0), th), Hit::Tile(ri, ci as i32)));
            }
            g.clip(None);
        }
    }

    fn draw_tile(&mut self, g: &mut Gfx, tx: &mut Text, pal: &Palette, kind: Kind, it: &Item, r: Rect, op: f32, focus: bool) {
        match kind {
            Kind::App => {
                let icon = Rect::new(r.x + 28.0, r.y + 14.0, 112.0, 112.0);
                match self.icons.get(&it.id).and_then(|t| *t) {
                    Some(t) => g.image(&t, icon, [0.0, 0.0, 1.0, 1.0], 14.0, op),
                    None => {
                        g.fill(icon, 14.0, Rgba::hex(LINE).a(op));
                        let letter: String = if it.lg { "LG".into() } else { it.title.chars().next().map(|c| c.to_string()).unwrap_or_default() };
                        let m = tx.metrics(Face::OutfitLight, 44.0);
                        let w = tx.width(&letter, Face::OutfitLight, 44.0, 0.0);
                        self.text_line(g, tx, &letter, Face::OutfitLight, 44.0, 0.0, icon.x + (112.0 - w) / 2.0, icon.y + m.baseline_in(112.0), pal.text.a(op), op);
                    }
                }
                let m = tx.metrics(Face::ManropeSemi, 21.0);
                let name = tx.ellipsize(&it.title, Face::ManropeSemi, 21.0, 0.0, 140.0);
                let w = tx.width(&name, Face::ManropeSemi, 21.0, 0.0);
                self.text_line(g, tx, &name, Face::ManropeSemi, 21.0, 0.0, r.x + (168.0 - w) / 2.0, r.y + 138.0 + m.baseline_in(m.normal()), pal.text.a(op), op);
            }
            Kind::Dev => {
                let last = self.last_on.kind.as_deref() == Some("input") && self.last_on.port == it.port;
                let path = if it.unused {
                    String::new()
                } else if let Some(v) = &it.via {
                    self.tv("home.dev.through", "HDMI {port}, through {via}", &[("port", it.port.to_string()), ("via", v.clone())])
                } else {
                    self.tv("home.dev.port", "HDMI {port}", &[("port", it.port.to_string())])
                };
                let (cx, cw) = (r.x + 20.0, 340.0);
                let m32 = tx.metrics(Face::Outfit, 32.0);
                let m20 = tx.metrics(Face::Manrope, 20.0);
                let m19 = tx.metrics(Face::Manrope, 19.0);
                let nm = tx.ellipsize(&it.title, Face::Outfit, 32.0, 0.0, cw);
                self.text_line(g, tx, &nm, Face::Outfit, 32.0, 0.0, cx, r.y + 16.0 + m32.baseline_in(m32.normal()), pal.text.a(op), op);
                let p = tx.ellipsize(&path, Face::Manrope, 20.0, 0.0, cw);
                self.text_line(g, tx, &p, Face::Manrope, 20.0, 0.0, cx, r.y + 16.0 + m32.normal() + 2.0 + m20.baseline_in(m20.normal()), pal.mid.a(op), op);
                let status = if last {
                    self.t("home.dev.last", "Last watched")
                } else if it.unused {
                    self.t("home.dev.unused", "Nothing connected")
                } else {
                    self.t("home.dev.connected", "Connected")
                };
                // A flex column spaced between, its status at the foot: where the
                // name and path leave no room the status follows them instead.
                let first_h = m32.normal() + 2.0 + if path.is_empty() { 0.0 } else { m20.normal() };
                let st_top = if first_h + m19.normal() <= 90.0 { r.y + 106.0 - m19.normal() } else { r.y + 16.0 + first_h };
                let sb = st_top + m19.baseline_in(m19.normal());
                let mut sx = cx;
                if last {
                    g.fill(Rect::new(sx, sb - 2.0 - 8.0, 8.0, 8.0), 4.0, pal.accent.a(op));
                    sx += 18.0;
                }
                self.text_line(g, tx, &status, Face::Manrope, 19.0, 0.0, sx, sb, if last { pal.accent } else { pal.low }.a(op), op);
                if let Some(a) = &it.address {
                    let cec = self.tv("home.dev.cec", "CEC {address}", &[("address", a.clone())]);
                    let w = tx.width(&cec, Face::Manrope, 19.0, 0.0);
                    self.text_line(g, tx, &cec, Face::Manrope, 19.0, 0.0, cx + cw - w, sb, pal.low.a(op), op);
                }
            }
            Kind::Ch => {
                let (cx, cw) = (r.x + 20.0, 184.0);
                let m48 = tx.metrics(Face::OutfitLight, 48.0);
                let m21 = tx.metrics(Face::Manrope, 21.0);
                let m21s = tx.metrics(Face::ManropeSemi, 21.0);
                let m17 = tx.metrics(Face::Manrope, 17.0);
                let mut y = r.y + 16.0;
                let num = tx.ellipsize(&it.number, Face::OutfitLight, 48.0, 0.0, cw);
                self.text_line(g, tx, &num, Face::OutfitLight, 48.0, 0.0, cx, y + m48.baseline_in(48.0 * 0.9), pal.text.a(op), op);
                y += 48.0 * 0.9 + 6.0;
                let nm = tx.ellipsize(&it.title, Face::Manrope, 21.0, 0.0, cw);
                self.text_line(g, tx, &nm, Face::Manrope, 21.0, 0.0, cx, y + m21.baseline_in(m21.normal()), pal.mid.a(op), op);
                y += m21.normal();
                let shows = self.guide.get(&it.id).cloned().unwrap_or_default();
                if let Some(on) = shows.first() {
                    y += 12.0;
                    let prog = tx.ellipsize(&on.title, Face::ManropeSemi, 21.0, 0.0, cw);
                    self.text_line(g, tx, &prog, Face::ManropeSemi, 21.0, 0.0, cx, y + m21s.baseline_in(m21s.normal()), pal.text.a(op), op);
                    y += m21s.normal() + 10.0;
                    let pct = ((i18n::now_ms() - on.start) / (on.end - on.start)).clamp(0.0, 1.0) as f32;
                    g.fill(Rect::new(cx, y, cw, 2.0), 0.0, Rgba::hex(LINE).a(op));
                    g.fill(Rect::new(cx, y, cw * pct, 2.0), 0.0, if focus { pal.text } else { pal.mid }.a(op));
                    y += 2.0;
                    if let Some(next) = shows.get(1) {
                        y += 8.0;
                        let line = format!("{} {}", i18n::hm(next.start), next.title);
                        let l = tx.ellipsize(&line, Face::Manrope, 17.0, 0.0, cw);
                        self.text_line(g, tx, &l, Face::Manrope, 17.0, 0.0, cx, y + m17.baseline_in(m17.normal()), pal.low.a(op), op);
                    }
                }
            }
        }
    }

    fn draw_banner(&mut self, g: &mut Gfx, tx: &mut Text, pal: &Palette) {
        let m20 = tx.metrics(Face::Manrope, 20.0);
        let line = m20.normal();
        let kind = self.row_key();
        let c = self.col_of(kind);
        let it = if c >= 0 { self.items(kind).get(c as usize).cloned() } else { None };
        let state = if c == -1 {
            self.tv("home.arrange.sortFocus", "{row}: OK changes the order", &[("row", self.row_title(kind))])
        } else {
            match &it {
                None => self.t("home.arrange.emptyRow", "This row is empty"),
                Some(it) if self.held => self.tv("home.arrange.moving", "Moving {name}", &[("name", it.title.clone())]),
                Some(it) => {
                    format!("{}{}", it.title, if self.hidden(kind, &it.id) { format!(" {}", self.t("home.arrange.isHidden", "(hidden)")) } else { String::new() })
                }
            }
        };
        let title = self.t("home.arrange.title", "Arranging");
        let keys = self.t(
            "home.arrange.keys",
            "OK picks a tile up or puts it down. Held, the arrows move it or its row, and Back hides or shows it, or removes a channel. Left of a row, OK sets its order.",
        );
        let hide = if self.last.as_ref().map(|l| l.0 == Kind::Ch).unwrap_or(false) {
            self.t("home.arrange.removeChannel", "Remove channel")
        } else {
            self.t("home.arrange.hide", "Hide or show")
        };
        let btns = [hide, self.t("home.arrange.reset", "Reset"), self.t("home.arrange.done", "Done")];
        // A flex row: the state and the buttons as wide as their text, the
        // key help taking what is left and wrapping in it.
        let title_w = tx.width(&title, Face::ManropeSemi, 20.0, 0.0) + 8.0;
        let state_w = tx.width(&state, Face::Manrope, 20.0, 0.0);
        let first_w = title_w + state_w;
        let btn_w: Vec<f32> = btns.iter().map(|b| tx.width(b, Face::Manrope, 20.0, 0.0) + 36.0).collect();
        let inner = 1696.0 - 3.0 - 44.0;
        let keys_w = (inner - first_w - 34.0 - btn_w.iter().map(|w| w + 12.0).sum::<f32>()).max(200.0);
        let key_lines = tx.wrap(&keys, Face::Manrope, 20.0, 0.0, keys_w);
        let content_h = (key_lines.len() as f32 * line).max(line + 16.0);
        let h = content_h + 28.0;
        let top = 1080.0 - 26.0 - h;
        let r = Rect::new(112.0, top, 1696.0, h);
        g.edged(r, 6.0, 3.0, Rgba::hex(PANEL), pal.accent);
        let mid = top + h / 2.0;
        let mut x = 112.0 + 3.0 + 22.0;
        let base = mid - line / 2.0 + m20.baseline_in(line);
        x += self.text_line(g, tx, &title, Face::ManropeSemi, 20.0, 0.0, x, base, pal.text, 0.0) + 8.0;
        self.text_line(g, tx, &state, Face::Manrope, 20.0, 0.0, x, base, pal.mid, 0.0);
        x = 112.0 + 3.0 + 22.0 + first_w + 34.0;
        let ky = mid - key_lines.len() as f32 * line / 2.0;
        for (i, l) in key_lines.iter().enumerate() {
            self.text_line(g, tx, l, Face::Manrope, 20.0, 0.0, x, ky + i as f32 * line + m20.baseline_in(line), pal.mid, 0.0);
        }
        let mut bx = 1808.0 - 22.0 - btn_w.iter().map(|w| w + 12.0).sum::<f32>();
        for (i, b) in btns.iter().enumerate() {
            bx += 12.0;
            let br = Rect::new(bx, mid - (line + 16.0) / 2.0, btn_w[i], line + 16.0);
            g.fill(br, 5.0, pal.held);
            if self.bar == i as i32 {
                g.outline(br, 5.0, 2.0, 0.0, pal.accent);
            }
            self.text_line(g, tx, b, Face::Manrope, 20.0, 0.0, bx + 18.0, br.y + 8.0 + m20.baseline_in(line), pal.text, 0.0);
            self.hits.push((br, Hit::Bar(i)));
            bx += btn_w[i];
        }
    }

    fn draw_toast(&mut self, g: &mut Gfx, tx: &mut Text, pal: &Palette, s: f64) {
        let a = self.toast_anim.value(s);
        if a <= 0.0 {
            if self.toast_anim.target() == 0.0 {
                self.toast = None;
            }
            return;
        }
        let (main, detail) = match &self.toast {
            Some(t) => t.clone(),
            None => return,
        };
        let m23 = tx.metrics(Face::Manrope, 23.0);
        let m18 = tx.metrics(Face::Manrope, 18.0);
        let max = 1100.0 - 44.0 - 3.0;
        let ml = tx.wrap(&main, Face::Manrope, 23.0, 0.0, max);
        let dl = if detail.is_empty() { Vec::new() } else { tx.wrap(&detail, Face::Manrope, 18.0, 0.0, max) };
        let mut w = 0.0f32;
        for l in &ml {
            w = w.max(tx.width(l, Face::Manrope, 23.0, 0.0));
        }
        for l in &dl {
            w = w.max(tx.width(l, Face::Manrope, 18.0, 0.0));
        }
        let h = 28.0 + ml.len() as f32 * m23.normal() + if dl.is_empty() { 0.0 } else { 4.0 + dl.len() as f32 * m18.normal() };
        let bottom = if self.arranging { 96.0 } else { 26.0 };
        let y = 1080.0 - bottom - h + 8.0 * (1.0 - a);
        let r = Rect::new(112.0, y, w + 47.0, h);
        g.edged(r, 6.0, 3.0, Rgba::hex(PANEL).a(a), pal.accent.a(a));
        let mut ly = y + 14.0;
        for l in &ml {
            self.text_line(g, tx, l, Face::Manrope, 23.0, 0.0, 137.0, ly + m23.baseline_in(m23.normal()), pal.text.a(a), 0.0);
            ly += m23.normal();
        }
        if !dl.is_empty() {
            ly += 4.0;
            for l in &dl {
                self.text_line(g, tx, l, Face::Manrope, 18.0, 0.0, 137.0, ly + m18.baseline_in(m18.normal()), pal.mid.a(a), 0.0);
                ly += m18.normal();
            }
        }
    }

    fn draw_recents(&mut self, g: &mut Gfx, tx: &mut Text, pal: &Palette, s: f64) {
        let p = self.recents.slide.value(s);
        if p <= 0.0 {
            return;
        }
        let top = 520.0 + 560.0 * (1.0 - p);
        let k = |a: f32| Rgba(0.0, 0.0, 0.0, a);
        g.gradient(Rect::new(0.0, top, 1920.0, 120.0), true, &[(0.0, k(0.0)), (64.0 / 120.0, k(0.94)), (1.0, k(1.0))]);
        g.fill(Rect::new(0.0, top + 120.0, 1920.0, 440.0), 0.0, k(1.0));
        let m40 = tx.metrics(Face::OutfitLight, 40.0);
        let m21 = tx.metrics(Face::Manrope, 21.0);
        // A row aligned on the baseline: as tall as the most either reaches above
        // it plus the most either reaches below.
        let above = m40.baseline_in(m40.normal()).max(8.0 + m21.baseline_in(m21.normal()));
        let below = (m40.normal() - m40.baseline_in(m40.normal())).max(m21.normal() + 8.0 - m21.baseline_in(m21.normal()));
        let head_h = above + below;
        let hy = top + 92.0;
        let base = hy + above;
        let title = self.t("home.recents.title", "Recent apps");
        self.text_line(g, tx, &title, Face::OutfitLight, 40.0, -0.3, 112.0, base, pal.text, 0.0);
        if !self.recents.apps.is_empty() {
            let label = self.t("home.recents.closeAll", "Close all");
            let w = tx.width(&label, Face::Manrope, 21.0, 0.0) + 36.0;
            let bh = m21.normal() + 16.0;
            let r = Rect::new(1808.0 + 18.0 - w, base - 8.0 - m21.baseline_in(m21.normal()), w, bh);
            if self.recents.on_all {
                g.fill(r, 5.0, BG_FOCUS);
                g.outline(r, 5.0, 2.0, 0.0, pal.focus);
            }
            self.text_line(g, tx, &label, Face::Manrope, 21.0, 0.0, r.x + 18.0, base, if self.recents.on_all { pal.text } else { pal.mid }, 0.0);
            self.hits.push((r, Hit::CloseAll));
        }
        let wy = hy + head_h + 18.0;
        let cy = wy + 6.0;
        if self.recents.apps.is_empty() {
            let m32 = tx.metrics(Face::OutfitLight, 32.0);
            let m26 = tx.metrics(Face::Manrope, 26.0);
            let y = cy + 8.0;
            let a = self.t("home.recents.none", "Nothing is open");
            let b = self.t("home.recents.noneDesc", "Apps stay here while they are open.");
            self.text_line(g, tx, &a, Face::OutfitLight, 32.0, 0.0, 112.0, y + m32.baseline_in(m32.normal()), pal.text, 0.6);
            self.text_line(g, tx, &b, Face::Manrope, 26.0, 0.0, 112.0, y + m32.normal() + 8.0 + m26.baseline_in(m26.normal()), pal.mid, 0.6);
            return;
        }
        let scroll = self.recents.track.value(s);
        g.clip(Some(Rect::new(90.0, wy, 1740.0, 1080.0 - wy)));
        let m22 = tx.metrics(Face::ManropeSemi, 22.0);
        let m19 = tx.metrics(Face::Manrope, 19.0);
        let m72 = tx.metrics(Face::OutfitLight, 72.0);
        let apps = self.recents.apps.clone();
        for (i, a) in apps.iter().enumerate() {
            let x = 112.0 + i as f32 * 404.0 - scroll;
            if x + 372.0 < 80.0 || x > 1840.0 {
                continue;
            }
            let focus = i == self.recents.col && !self.recents.on_all;
            let op = if focus { 1.0 } else { 0.5 };
            let shot = Rect::new(x, cy, 372.0, 209.0);
            g.fill(shot, 6.0, Rgba::hex(PANEL).a(op));
            match self.recents.shots.get(&a.id).filter(|_| a.image).map(|s| s.0) {
                Some(t) => {
                    // object-fit: cover.
                    let (tw, th) = (t.w as f32, t.h as f32);
                    let k = (372.0 / tw).max(209.0 / th);
                    let (vw, vh) = (372.0 / k / tw, 209.0 / k / th);
                    let (u0, v0) = ((1.0 - vw) / 2.0, (1.0 - vh) / 2.0);
                    g.image(&t, shot, [u0, v0, u0 + vw, v0 + vh], 6.0, op);
                }
                None => {
                    let ch: String = a.title.chars().next().map(|c| c.to_string()).unwrap_or_default();
                    let w = tx.width(&ch, Face::OutfitLight, 72.0, 0.0);
                    self.text_line(g, tx, &ch, Face::OutfitLight, 72.0, 0.0, x + (372.0 - w) / 2.0, cy + m72.baseline_in(209.0), pal.low.a(op), op);
                }
            }
            if focus {
                g.outline(shot, 6.0, 2.0, 4.0, if self.recents.on_x { Rgba::hex(0x3a3732) } else { pal.focus });
            }
            let nm = tx.ellipsize(&a.title, Face::ManropeSemi, 22.0, 0.0, 372.0);
            let ny = cy + 209.0 + 18.0;
            self.text_line(g, tx, &nm, Face::ManropeSemi, 22.0, 0.0, x, ny + m22.baseline_in(m22.normal()), pal.text.a(op), op);
            let xy = ny + m22.normal() + 10.0;
            let label = self.t("home.recents.close", "Close");
            let xw = tx.width(&label, Face::Manrope, 19.0, 0.0) + 24.0;
            let xr = Rect::new(x - 12.0, xy, xw, m19.normal() + 10.0);
            if focus {
                if self.recents.on_x {
                    g.fill(xr, 4.0, BG_FOCUS);
                    g.outline(xr, 4.0, 2.0, 0.0, pal.focus);
                }
                self.text_line(g, tx, &label, Face::Manrope, 19.0, 0.0, x, xy + 5.0 + m19.baseline_in(m19.normal()), if self.recents.on_x { pal.text } else { pal.mid }, op);
                self.hits.push((xr, Hit::Card(i, true)));
            }
            self.hits.push((Rect::new(x, cy, 372.0, 209.0 + 18.0 + m22.normal()), Hit::Card(i, false)));
        }
        g.clip(None);
    }

    fn draw_fault(&mut self, g: &mut Gfx, tx: &mut Text, pal: &Palette) {
        let m56 = tx.metrics(Face::OutfitLight, 56.0);
        let m26 = tx.metrics(Face::Manrope, 26.0);
        let h1 = self.t("home.fault.title", "Glasshouse is not answering");
        let p = self.t(
            "home.fault.desc",
            "Glasshouse Home comes back when it answers. Should it stay silent, LG's Home comes back in a few minutes.",
        );
        self.text_line(g, tx, &h1, Face::OutfitLight, 56.0, 0.0, 112.0, 420.0 + m56.baseline_in(m56.normal()), pal.text, 0.0);
        let mut y = 420.0 + m56.normal() + 18.0;
        for l in tx.wrap(&p, Face::Manrope, 26.0, 0.0, 1200.0) {
            self.text_line(g, tx, &l, Face::Manrope, 26.0, 0.0, 112.0, y + m26.baseline_in(m26.normal()), pal.mid, 0.0);
            y += m26.normal();
        }
    }

    #[allow(dead_code)]
    fn search_strings(&self) {
        let _ = self.t("home.search.rail", "Search");
        let _ = self.t("home.search.placeholder", "Film or series");
        let _ = self.t("home.search.blockedTitle", "Search is unavailable");
        let _ = self.tv(
            "home.search.blockedList",
            "The ad blocker\u{2019}s hosts list blocks {host}, which LG\u{2019}s search needs. Take it out of the list on the dashboard\u{2019}s Privacy tab.",
            &[("host", String::new())],
        );
        let _ = self.t(
            "home.search.blockedLevel",
            "The ad blocker\u{2019}s Everything setting blocks LG\u{2019}s search. Set it to Ads & telemetry or off on the dashboard\u{2019}s Privacy tab.",
        );
        let _ = self.t("home.search.ready", "Films and series on this TV\u{2019}s apps, from LG\u{2019}s search");
        let _ = self.tv("home.search.looking", "Looking for \u{201c}{query}\u{201d}", &[("query", String::new())]);
        let _ = self.t(
            "home.search.failed",
            "LG\u{2019}s search did not answer. It needs the TV online, and the ad blocker on Ads & telemetry or off.",
        );
        let _ = self.tv(
            "home.search.onlyElsewhere",
            "Nothing for \u{201c}{query}\u{201d} on this TV\u{2019}s apps. {n} more on apps it does not have.",
            &[("query", String::new()), ("n", String::new())],
        );
        let _ = self.tv("home.search.none", "Nothing for \u{201c}{query}\u{201d}", &[("query", String::new())]);
        let _ = self.tv(
            "home.search.foundOneMore",
            "1 title on this TV\u{2019}s apps, {more} more on apps it does not have",
            &[("more", String::new())],
        );
        let _ = self.tv(
            "home.search.foundMore",
            "{n} titles on this TV\u{2019}s apps, {more} more on apps it does not have",
            &[("n", String::new()), ("more", String::new())],
        );
        let _ = self.t("home.search.foundOne", "1 title on this TV\u{2019}s apps");
        let _ = self.tv("home.search.found", "{n} titles on this TV\u{2019}s apps", &[("n", String::new())]);
        let _ = self.tv("home.search.minutes", "{m} min", &[("m", String::new())]);
        let _ = self.tv("home.search.hoursMinutes", "{h} h {m} min", &[("h", String::new()), ("m", String::new())]);
        let _ = self.tv("home.search.hours", "{h} h", &[("h", String::new())]);
        let _ = self.t("home.search.film", "Film");
        let _ = self.t("home.search.series", "Series");
        let _ = self.tv("home.search.opening", "Opening {title} on {app}", &[("title", String::new()), ("app", String::new())]);
        let _ = self.t("home.search.hintTitle", "Search is left of the rows");
        let _ = self.t(
            "home.search.hintDesc",
            "Press left on a row\u{2019}s first tile to find a film or series and open it in an app on this TV",
        );
    }
}

fn fmt_hz(v: f64) -> String {
    let r = (v * 100.0).round() / 100.0;
    if r == r.trunc() {
        format!("{}", r as i64)
    } else {
        let s = format!("{:.2}", r);
        s.trim_end_matches('0').to_string()
    }
}

/// encodeURIComponent.
pub fn enc(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

#[cfg(test)]
#[path = "view_tests.rs"]
mod tests;
