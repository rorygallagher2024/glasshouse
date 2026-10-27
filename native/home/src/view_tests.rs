//! The view's behaviour against a server played by hand: the requests it
//! makes are read off the fake Api, and the replies given back as the server
//! would answer. These carry over the browser checks the web view had.

use super::*;
use crate::api::Job;
use std::sync::mpsc::Receiver;

struct Fixture {
    v: View,
    jobs: Receiver<(Tag, Job)>,
}

fn layout(sort_app: &str) -> Value {
    json!({
        "rows": ["app", "dev", "ch"],
        "order": { "app": [], "dev": [], "ch": [] },
        "sort": { "app": sort_app, "dev": "custom", "ch": "custom" },
        "hidden": { "app": [], "dev": [], "ch": [] },
        "channels": [], "hintSeen": true
    })
}

/// The catalogue as the server sends it: a Last opened row already in that order.
fn catalogue(sort_app: &str) -> Value {
    let order = if sort_app == "recent" { json!(["two", "one", "lg-home"]) } else { json!(["one", "two", "lg-home"]) };
    json!({
        "ok": true,
        "apps": [{ "id": "one", "title": "One" }, { "id": "two", "title": "Two" }],
        "devices": [], "channels": [],
        "sources": { "channels": 0 },
        "order": { "app": order, "dev": [], "ch": [] },
        "layout": layout(sort_app),
        "layoutVersion": "1"
    })
}

impl Fixture {
    fn new(sort_app: &str) -> Fixture {
        let (api, jobs, _images) = Api::fake();
        std::mem::forget(_images);
        let mut f = Fixture { v: View::new(api, I18n::load("/nonexistent", "en"), None, None, 0.0), jobs };
        f.v.start();
        f.answer_catalogue(sort_app);
        f
    }

    /// Requests made since last asked, by path.
    fn sent(&mut self) -> Vec<(Tag, String, Option<Value>)> {
        let mut out = Vec::new();
        while let Ok((tag, job)) = self.jobs.try_recv() {
            match job {
                Job::Get(p) => out.push((tag, p, None)),
                Job::Post(p, b) => out.push((tag, p, Some(b))),
            }
        }
        out
    }

    /// Answers every catalogue request waiting with `sort_app`'s catalogue.
    fn answer_catalogue(&mut self, sort_app: &str) {
        for (tag, path, _) in self.sent() {
            if path == "/api/home/catalogue" {
                self.v.reply(tag, Reply::Json(Some(catalogue(sort_app))));
            }
        }
    }

    fn press(&mut self, k: Key) {
        self.v.key_down(k, false);
        self.v.key_up(k);
    }

    /// OK held long enough to arrange, then let go.
    fn hold_ok(&mut self) {
        self.v.key_down(Key::Ok, false);
        self.v.ok_down_at -= LONG_PRESS_MS + 1.0;
        self.v.tick();
        self.v.key_up(Key::Ok);
    }

    fn app_titles(&self) -> Vec<String> {
        self.v.items(Kind::App).iter().map(|i| i.title.clone()).collect()
    }
}

#[test]
fn ok_opens_the_focused_tile_once_on_release() {
    let mut f = Fixture::new("custom");
    f.sent();
    f.v.key_down(Key::Ok, false);
    f.v.key_down(Key::Ok, true);
    assert!(f.sent().is_empty(), "nothing opens while OK is down");
    f.v.key_up(Key::Ok);
    let sent = f.sent();
    let opens: Vec<_> = sent.iter().filter(|s| s.1 == "/api/home/open").collect();
    assert_eq!(opens.len(), 1);
    assert_eq!(opens[0].2.as_ref().unwrap()["id"], "one");
}

#[test]
fn a_click_opens_its_tile_after_directional_navigation() {
    let mut f = Fixture::new("custom");
    f.press(Key::Right);
    f.sent();
    f.v.hits.push((Rect::new(0.0, 0.0, 10.0, 10.0), Hit::Tile(0, 0)));
    f.v.click(5.0, 5.0);
    let opens: Vec<_> = f.sent().into_iter().filter(|s| s.1 == "/api/home/open").collect();
    assert_eq!(opens.len(), 1);
    assert_eq!(opens[0].2.as_ref().unwrap()["id"], "one");
}

#[test]
fn holding_ok_arranges_instead_of_opening() {
    let mut f = Fixture::new("custom");
    f.sent();
    f.hold_ok();
    assert!(f.v.arranging);
    assert!(f.sent().iter().all(|s| s.1 != "/api/home/open"));
}

#[test]
fn order_saves_last_opened_and_no_edit_is_lost_while_it_saves() {
    let mut f = Fixture::new("custom");
    f.hold_ok();
    f.press(Key::Left);
    assert_eq!(f.v.col_of(Kind::App), -1, "left of the first tile is the row's Order");
    f.sent();
    f.press(Key::Ok);
    let save = f.sent().into_iter().find(|s| s.1 == "/api/home/layout").expect("Order saves");
    assert_eq!(save.2.as_ref().unwrap()["sort"]["app"], "recent");
    // Moves tried while the save is out are refused, not lost later.
    for k in [Key::Right, Key::Ok, Key::Right, Key::Ok] {
        f.press(k);
    }
    assert_eq!(f.app_titles(), ["One", "Two", "LG Home"]);
    let mut saved = layout("recent");
    saved["sort"]["app"] = json!("recent");
    f.v.reply(save.0, Reply::Posted(Some((200, json!({ "ok": true, "layout": saved })))));
    // ... and while the order it brings is loading.
    for k in [Key::Right, Key::Ok, Key::Right, Key::Ok] {
        f.press(k);
    }
    assert_eq!(f.app_titles(), ["One", "Two", "LG Home"]);
    f.answer_catalogue("recent");
    assert_eq!(f.app_titles(), ["Two", "One", "LG Home"], "arranging shows the row in last opened order");
    assert!(!f.v.layout_busy);
}

#[test]
fn moving_a_tile_in_a_last_opened_row_keeps_the_order_shown_as_its_own() {
    let mut f = Fixture::new("recent");
    f.hold_ok();
    assert_eq!(f.app_titles(), ["Two", "One", "LG Home"]);
    f.press(Key::Ok); // pick Two up
    assert!(f.v.held);
    f.press(Key::Right);
    f.press(Key::Ok); // put it down after One
    f.sent();
    f.press(Key::Back); // done
    let save = f.sent().into_iter().find(|s| s.1 == "/api/home/layout").expect("leaving arranging saves");
    let body = save.2.unwrap();
    assert_eq!(body["sort"]["app"], "custom");
    assert_eq!(body["order"]["app"], json!(["one", "two", "lg-home"]));
}

#[test]
fn switching_order_keeps_the_rows_unsaved_moves() {
    let mut f = Fixture::new("custom");
    f.hold_ok();
    f.press(Key::Ok); // pick One up
    f.press(Key::Right);
    f.press(Key::Ok); // put it down: Two, One
    f.press(Key::Left);
    f.press(Key::Left); // the row's Order
    f.sent();
    f.press(Key::Ok);
    let save = f.sent().into_iter().find(|s| s.1 == "/api/home/layout").expect("Order saves");
    assert_eq!(save.2.unwrap()["order"]["app"], json!(["two", "one", "lg-home"]));
}

#[test]
fn clicking_order_while_holding_a_tile_lets_it_go() {
    let mut f = Fixture::new("custom");
    f.hold_ok();
    f.press(Key::Ok);
    assert!(f.v.held);
    f.v.hits.push((Rect::new(0.0, 0.0, 10.0, 10.0), Hit::Sort(0)));
    f.v.click(5.0, 5.0);
    assert!(!f.v.held);
}

#[test]
fn a_first_catalogue_that_fails_shows_the_fault_and_opens_lg_home_once() {
    let (api, jobs, _images) = Api::fake();
    let mut v = View::new(api, I18n::load("/nonexistent", "en"), None, None, 0.0);
    v.start();
    let mut escapes = 0;
    for _ in 0..3 {
        while let Ok((tag, job)) = jobs.try_recv() {
            match job {
                Job::Get(p) if p == "/api/home/catalogue" => v.reply(tag, Reply::Json(None)),
                Job::Post(p, b) if p == "/api/home/open" && b["kind"] == "lg" => escapes += 1,
                _ => {}
            }
        }
        v.load(false, Then::Nothing);
    }
    assert!(v.fault);
    assert_eq!(escapes, 1, "LG's Home is opened once, not at every retry");
}

#[test]
fn back_cancels_a_recent_apps_panel_still_loading() {
    let mut f = Fixture::new("custom");
    f.sent();
    f.press(Key::Back);
    let req = f.sent().into_iter().find(|s| s.1 == "/api/home/recents").expect("Back asks for recent apps");
    f.press(Key::Back);
    f.v.reply(req.0, Reply::Json(Some(json!({ "ok": true, "apps": [{ "id": "x", "title": "X" }] }))));
    assert!(!f.v.recents.open, "a late reply does not open the panel");
}

#[test]
fn the_heartbeat_names_the_process_and_a_new_build_restarts() {
    let mut f = Fixture::new("custom");
    let beat = f.sent().into_iter().find(|s| s.1 == "/api/home/beat").expect("a heartbeat once loaded");
    let pid = &beat.2.as_ref().unwrap()["pid"];
    if cfg!(target_arch = "arm") {
        assert_eq!(pid, &json!(std::process::id()));
    } else {
        assert!(pid.is_null(), "a desktop preview cannot register its PID on the TV");
    }
    f.v.reply(beat.0, Reply::Posted(Some((200, json!({ "ok": true, "build": "a" })))));
    assert!(!f.v.restart_for_build);
    f.v.reply(Tag::Beat, Reply::Posted(Some((200, json!({ "ok": true, "build": "b" })))));
    assert!(f.v.restart_for_build);
}

#[test]
fn a_scrolled_tile_stays_between_the_rows_edges() {
    let mut f = Fixture::new("custom");
    let ids: Vec<Value> = (0..20).map(|i| json!({ "id": format!("a{}", i), "title": format!("A{}", i) })).collect();
    let mut c = catalogue("custom");
    c["apps"] = json!(ids);
    c["order"]["app"] = json!((0..20).map(|i| format!("a{}", i)).collect::<Vec<_>>());
    f.v.reply(Tag::Catalogue { revision: f.v.layout_revision, while_arranging: false, then: Then::Nothing }, Reply::Json(Some(c)));
    for _ in 0..15 {
        f.press(Key::Right);
    }
    let x = |f: &Fixture| f.v.tracks[&Kind::App].target();
    let screen_right = 112.0 + 15.0 * 176.0 + 168.0 - x(&f);
    assert_eq!(screen_right, 1808.0, "moving right, the tile stops at the right edge");
    for _ in 0..10 {
        f.press(Key::Left);
    }
    let screen_left = 112.0 + 5.0 * 176.0 - x(&f);
    assert_eq!(screen_left, 112.0, "moving left, at the left edge");
}
