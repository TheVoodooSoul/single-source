// Desk — the menu bar light for Adam's crew (2026-10-29).
// Green: nothing waits on Adam. Red: a card is in review or an agent asked him something.
// Click: who is doing what, sign off / send back a card, answer a question.
// Bells: 9:00 stand-up, 1:30 nudge (only if something waits), 6:00 close — posted to the bus, shown as notifications.
import Cocoa
import UserNotifications

let BUS = "http://127.0.0.1:7790"
let SEEN_PATH = NSString(string: "~/agent-bus/desk-seen.json").expandingTildeInPath
let FIRED_PATH = NSString(string: "~/agent-bus/desk-fired.json").expandingTildeInPath

func http(_ method: String, _ path: String, _ body: [String: Any]? = nil) -> Any? {
    guard let url = URL(string: BUS + path) else { return nil }
    var req = URLRequest(url: url, timeoutInterval: 6)
    req.httpMethod = method
    if let b = body {
        req.httpBody = try? JSONSerialization.data(withJSONObject: b)
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    let sem = DispatchSemaphore(value: 0)
    var out: Any? = nil
    URLSession.shared.dataTask(with: req) { data, _, _ in
        if let d = data { out = try? JSONSerialization.jsonObject(with: d) }
        sem.signal()
    }.resume()
    _ = sem.wait(timeout: .now() + 7)
    return out
}

func loadSet(_ path: String) -> Set<String> {
    guard let d = FileManager.default.contents(atPath: path),
          let a = (try? JSONSerialization.jsonObject(with: d)) as? [String] else { return [] }
    return Set(a)
}
func saveSet(_ s: Set<String>, _ path: String) {
    if let d = try? JSONSerialization.data(withJSONObject: Array(s).sorted()) { FileManager.default.createFile(atPath: path, contents: d) }
}

struct Card { let id: String; let agent: String; let title: String; let col: String; let note: String; let by: String }
struct Ask { let id: String; let from: String; let subject: String; let body: String; let ts: String }
struct Who { let id: String; let name: String; let hp: Int; let note: String; let doing: [String] }

final class Desk: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    var item: NSStatusItem!
    var review: [Card] = []
    var asks: [Ask] = []
    var crew: [Who] = []
    var busUp = true
    var seen = loadSet(SEEN_PATH)
    var fired = loadSet(FIRED_PATH)

    func applicationDidFinishLaunching(_ n: Notification) {
        // Sit right next to the clock. The menu bar on this machine is over-full and macOS drops
        // the newest (leftmost) items first; the preferred position is the distance from the right edge.
        let posKey = "NSStatusItem Preferred Position desk"
        if UserDefaults.standard.object(forKey: posKey) == nil { UserDefaults.standard.set(30, forKey: posKey) }
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.autosaveName = "desk"
        item.behavior = []
        item.button?.title = "●"
        item.menu = NSMenu()
        let un = UNUserNotificationCenter.current()
        un.delegate = self
        un.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
        refresh()
        Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { _ in self.refresh() }
        Timer.scheduledTimer(withTimeInterval: 20, repeats: true) { _ in self.bells() }
    }

    func userNotificationCenter(_ c: UNUserNotificationCenter, willPresent n: UNNotification, withCompletionHandler h: @escaping (UNNotificationPresentationOptions) -> Void) {
        h([.banner, .sound])
    }

    // MARK: read the bus
    func refresh() {
        DispatchQueue.global().async {
            var cards: [Card] = []
            var up = false
            if let b = http("GET", "/api/board") as? [String: Any], let cs = b["cards"] as? [[String: Any]] {
                up = true
                cards = cs.map { Card(id: $0["id"] as? String ?? "", agent: $0["agent"] as? String ?? "", title: $0["title"] as? String ?? "",
                                      col: $0["col"] as? String ?? "", note: $0["note"] as? String ?? "", by: $0["by"] as? String ?? "") }
            }
            var who: [Who] = []
            if let c = http("GET", "/api/crew") as? [String: Any] {
                var list: [[String: Any]] = []
                if let d = c["agents"] as? [String: [String: Any]] { list = Array(d.values) }
                else if let a = c["agents"] as? [[String: Any]] { list = a }
                for a in list {
                    let id = a["id"] as? String ?? ""
                    if id.isEmpty || (a["kind"] as? String) == "human" || id == "adam" { continue }
                    let doing = cards.filter { $0.agent == id && $0.col == "doing" }.map { $0.title }
                    who.append(Who(id: id, name: a["name"] as? String ?? id, hp: a["hp"] as? Int ?? 100, note: a["hpNote"] as? String ?? "", doing: doing))
                }
                who.sort { $0.name < $1.name }
            }
            var asks: [Ask] = []
            if let r = http("GET", "/api/read?agent=adam&mark=0") as? [String: Any], let ms = r["messages"] as? [[String: Any]] {
                for m in ms.suffix(300) {
                    let to = m["to"] as? String ?? ""
                    let from = m["from"] as? String ?? ""
                    let id = m["id"] as? String ?? ""
                    if to != "adam" || from == "adam" || from == "single-source" || from == "desk" || self.seen.contains(id) { continue }
                    asks.append(Ask(id: id, from: from, subject: m["subject"] as? String ?? "", body: m["body"] as? String ?? "", ts: m["ts"] as? String ?? ""))
                }
            }
            DispatchQueue.main.async {
                self.busUp = up
                self.review = cards.filter { $0.col == "review" }
                self.asks = Array(asks.suffix(12).reversed())
                self.crew = who
                self.rebuild()
            }
        }
    }

    var waiting: Int { review.count + asks.count }

    func light() {
        let color: NSColor = !busUp ? .systemGray : (waiting > 0 ? .systemRed : .systemGreen)
        let t = NSMutableAttributedString(string: "●", attributes: [.foregroundColor: color, .font: NSFont.systemFont(ofSize: 15)])
        if waiting > 0 { t.append(NSAttributedString(string: " \(waiting)", attributes: [.font: NSFont.systemFont(ofSize: 12, weight: .semibold)])) }
        item.button?.attributedTitle = t
        item.button?.toolTip = !busUp ? "The room is not running" : (waiting > 0 ? "\(waiting) waiting on you" : "Nothing waits on you")
    }

    func rebuild() {
        light()
        let m = NSMenu()
        func header(_ s: String) { let i = NSMenuItem(title: s, action: nil, keyEquivalent: ""); i.isEnabled = false; m.addItem(i) }
        if !busUp {
            header("The room is not running (localhost:7790)")
            m.addItem(NSMenuItem.separator())
        }
        header(waiting > 0 ? "WAITING ON YOU · \(waiting)" : "NOTHING WAITS ON YOU")
        for c in review {
            m.addItem(mk("✍︎  \(c.title)", #selector(openCard(_:)), c.id))
        }
        for a in asks {
            m.addItem(mk("?  \(a.from): \(a.subject.isEmpty ? String(a.body.prefix(60)) : a.subject)", #selector(openAsk(_:)), a.id))
        }
        m.addItem(NSMenuItem.separator())
        header("WHO IS DOING WHAT")
        if crew.isEmpty { header("   nobody has joined the room") }
        for w in crew {
            let hp = w.hp > 60 ? "🟢" : (w.hp >= 30 ? "🟡" : "🔴")
            let i = NSMenuItem(title: "\(hp) \(w.name) · HP \(w.hp)" + (w.doing.isEmpty ? " · idle" : ""), action: #selector(openRoom(_:)), keyEquivalent: "")
            i.target = self
            if !w.doing.isEmpty {
                let sub = NSMenu()
                for d in w.doing { let l = NSMenuItem(title: "→ " + String(d.prefix(80)), action: nil, keyEquivalent: ""); l.isEnabled = false; sub.addItem(l) }
                if !w.note.isEmpty { let l = NSMenuItem(title: "“\(String(w.note.prefix(80)))”", action: nil, keyEquivalent: ""); l.isEnabled = false; sub.addItem(l) }
                i.submenu = sub
            }
            m.addItem(i)
        }
        m.addItem(NSMenuItem.separator())
        header("Stand-up 9:00 · nudge 1:30 · close 6:00")
        m.addItem(mk("New card…  (give someone a task)", #selector(newCard(_:)), nil))
        m.addItem(mk("Message the crew…", #selector(message(_:)), nil))
        m.addItem(mk("Ask the crew for a line now", #selector(standupNow(_:)), nil))
        m.addItem(mk("Open the room", #selector(openRoom(_:)), nil))
        m.addItem(mk("Refresh", #selector(doRefresh(_:)), nil))
        m.addItem(NSMenuItem.separator())
        m.addItem(mk("Quit Desk", #selector(quit(_:)), nil))
        item.menu = m
    }

    func mk(_ title: String, _ sel: Selector, _ rep: Any?) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: sel, keyEquivalent: "")
        i.target = self; i.representedObject = rep; return i
    }
    func wrap(_ s: String, _ n: Int) -> [String] {
        var out: [String] = []; var line = ""
        for w in s.replacingOccurrences(of: "\n", with: " ").split(separator: " ") {
            if line.count + w.count + 1 > n { out.append(line); line = "" }
            line += (line.isEmpty ? "" : " ") + w
        }
        if !line.isEmpty { out.append(line) }
        return out
    }

    // MARK: open an item (click the line)
    @objc func openCard(_ s: NSMenuItem) {
        guard let id = s.representedObject as? String, let c = review.first(where: { $0.id == id }) else { return }
        NSApp.activate(ignoringOtherApps: true)
        let link = firstURL(c.note)
        let al = NSAlert()
        al.messageText = c.title
        al.informativeText = "\(c.agent) put this in review." + (c.note.isEmpty ? "" : "\n\n" + c.note) + "\n\nCard \(c.id)"
        al.addButton(withTitle: "Sign off ✓")
        al.addButton(withTitle: "Send back with a note…")
        al.addButton(withTitle: link == nil ? "Close" : "Open link")
        if link != nil { al.addButton(withTitle: "Close") }
        switch al.runModal() {
        case .alertFirstButtonReturn: move(id, "done", "Adam signed off from the menu bar")
        case .alertSecondButtonReturn: sendBackWithNote(c)
        case .alertThirdButtonReturn: if let u = link { NSWorkspace.shared.open(u) }
        default: break
        }
    }
    func firstURL(_ text: String) -> URL? {
        for w in text.split(whereSeparator: { $0 == " " || $0 == "\n" }) {
            let t = String(w).trimmingCharacters(in: CharacterSet(charactersIn: "()[]<>,;"))
            if t.hasPrefix("http://") || t.hasPrefix("https://"), let u = URL(string: t) { return u }
            if t.hasPrefix("~/") || t.hasPrefix("/Users/") { return URL(fileURLWithPath: NSString(string: t).expandingTildeInPath) }
        }
        return nil
    }
    func sendBackWithNote(_ c: Card) {
        let al = NSAlert()
        al.messageText = "Send back to \(c.agent)"
        al.informativeText = c.title
        let tf = NSTextField(frame: NSRect(x: 0, y: 0, width: 440, height: 72))
        tf.placeholderString = "What to change, or the question. Enter sends."
        al.accessoryView = tf
        al.addButton(withTitle: "Send back"); al.addButton(withTitle: "Cancel")
        al.window.initialFirstResponder = tf
        if al.runModal() == .alertFirstButtonReturn {
            let note = tf.stringValue.isEmpty ? "Adam sent it back from the menu bar" : "Adam: " + tf.stringValue
            let body = tf.stringValue
            DispatchQueue.global().async {
                _ = http("POST", "/api/card", ["op": "move", "id": c.id, "col": "doing", "note": note, "by": "adam"])
                if !body.isEmpty {
                    _ = http("POST", "/api/send", ["from": "adam", "to": c.agent, "kind": "note", "subject": "Sent back: " + String(c.title.prefix(60)), "body": body])
                }
                self.refresh()
            }
        }
    }
    @objc func openAsk(_ s: NSMenuItem) {
        guard let id = s.representedObject as? String, let a = asks.first(where: { $0.id == id }) else { return }
        NSApp.activate(ignoringOtherApps: true)
        let al = NSAlert()
        al.messageText = a.subject.isEmpty ? "\(a.from) asks" : a.subject
        al.informativeText = "From \(a.from) · \(a.ts)\n\n" + a.body
        al.addButton(withTitle: "Answer…")
        al.addButton(withTitle: "Seen, no answer needed")
        al.addButton(withTitle: "Close")
        switch al.runModal() {
        case .alertFirstButtonReturn:
            let fake = NSMenuItem(); fake.representedObject = [a.id, a.from, a.subject]; answer(fake)
        case .alertSecondButtonReturn:
            seen.insert(a.id); saveSet(seen, SEEN_PATH); refresh()
        default: break
        }
    }

    // MARK: actions
    @objc func signOff(_ s: NSMenuItem) { move(s.representedObject as? String ?? "", "done", "Adam signed off from the menu bar") }
    @objc func sendBack(_ s: NSMenuItem) { move(s.representedObject as? String ?? "", "doing", "Adam sent it back from the menu bar") }
    func move(_ id: String, _ col: String, _ note: String) {
        DispatchQueue.global().async {
            _ = http("POST", "/api/card", ["op": "move", "id": id, "col": col, "note": note, "by": "adam"])
            self.refresh()
        }
    }
    @objc func markSeen(_ s: NSMenuItem) {
        if let id = s.representedObject as? String { seen.insert(id); saveSet(seen, SEEN_PATH) }
        refresh()
    }
    @objc func answer(_ s: NSMenuItem) {
        guard let a = s.representedObject as? [String], a.count == 3 else { return }
        NSApp.activate(ignoringOtherApps: true)
        let al = NSAlert()
        al.messageText = "Answer \(a[1])"
        al.informativeText = a[2]
        let tf = NSTextField(frame: NSRect(x: 0, y: 0, width: 420, height: 72))
        tf.placeholderString = "Your answer. Enter sends."
        al.accessoryView = tf
        al.addButton(withTitle: "Send")
        al.addButton(withTitle: "Cancel")
        al.window.initialFirstResponder = tf
        if al.runModal() == .alertFirstButtonReturn, !tf.stringValue.isEmpty {
            let body = tf.stringValue
            seen.insert(a[0]); saveSet(seen, SEEN_PATH)
            DispatchQueue.global().async {
                _ = http("POST", "/api/send", ["from": "adam", "to": a[1], "kind": "reply", "subject": "Re: " + a[2], "body": body])
                self.refresh()
            }
        }
    }
    func agentPopup(_ frame: NSRect, all: Bool) -> NSPopUpButton {
        let pop = NSPopUpButton(frame: frame, pullsDown: false)
        if all { pop.addItem(withTitle: "everyone"); pop.lastItem?.representedObject = "*" }
        for w in crew { pop.addItem(withTitle: w.name); pop.lastItem?.representedObject = w.id }
        if crew.isEmpty { pop.addItem(withTitle: "claude-code"); pop.lastItem?.representedObject = "claude-code" }
        return pop
    }
    @objc func newCard(_ s: NSMenuItem) {
        NSApp.activate(ignoringOtherApps: true)
        let al = NSAlert()
        al.messageText = "New card"
        al.informativeText = "What needs doing, and who does it. It lands in their TO DO on the board."
        let box = NSView(frame: NSRect(x: 0, y: 0, width: 440, height: 96))
        let title = NSTextField(frame: NSRect(x: 0, y: 60, width: 440, height: 30)); title.placeholderString = "The task, in one line"
        let who = agentPopup(NSRect(x: 0, y: 20, width: 220, height: 28), all: false)
        let prio = NSPopUpButton(frame: NSRect(x: 230, y: 20, width: 210, height: 28), pullsDown: false)
        prio.addItems(withTitles: ["normal", "high", "urgent", "low"])
        box.addSubview(title); box.addSubview(who); box.addSubview(prio)
        al.accessoryView = box
        al.addButton(withTitle: "Add card"); al.addButton(withTitle: "Cancel")
        al.window.initialFirstResponder = title
        if al.runModal() == .alertFirstButtonReturn, !title.stringValue.isEmpty {
            let agent = who.selectedItem?.representedObject as? String ?? "claude-code"
            let t = title.stringValue, p = prio.titleOfSelectedItem ?? "normal"
            DispatchQueue.global().async {
                _ = http("POST", "/api/card", ["op": "add", "agent": agent, "title": t, "col": "todo", "prio": p, "note": "", "by": "adam"])
                _ = http("POST", "/api/send", ["from": "adam", "to": agent, "kind": "note", "subject": "New card: " + t, "body": "Added from the menu bar. Priority \(p). It is in your TO DO."])
                self.refresh()
            }
        }
    }
    @objc func message(_ s: NSMenuItem) {
        NSApp.activate(ignoringOtherApps: true)
        let al = NSAlert()
        al.messageText = "Message the crew"
        let box = NSView(frame: NSRect(x: 0, y: 0, width: 440, height: 110))
        let who = agentPopup(NSRect(x: 0, y: 80, width: 220, height: 28), all: true)
        let body = NSTextField(frame: NSRect(x: 0, y: 0, width: 440, height: 72)); body.placeholderString = "Say it. Enter sends."
        box.addSubview(who); box.addSubview(body)
        al.accessoryView = box
        al.addButton(withTitle: "Send"); al.addButton(withTitle: "Cancel")
        al.window.initialFirstResponder = body
        if al.runModal() == .alertFirstButtonReturn, !body.stringValue.isEmpty {
            let to = who.selectedItem?.representedObject as? String ?? "*"
            let b = body.stringValue
            DispatchQueue.global().async {
                _ = http("POST", "/api/send", ["from": "adam", "to": to, "kind": "note", "subject": String(b.prefix(60)), "body": b])
                self.refresh()
            }
        }
    }
    @objc func standupNow(_ s: NSMenuItem) { post("STAND-UP — one line each", "Done · next · blocked · needs Adam. One line. Reply to adam if you need him.") }
    @objc func openRoom(_ s: NSMenuItem) { NSWorkspace.shared.open(URL(string: BUS + "/")!) }
    @objc func doRefresh(_ s: NSMenuItem) { refresh() }
    @objc func quit(_ s: NSMenuItem) { NSApp.terminate(nil) }

    func post(_ subject: String, _ body: String) {
        DispatchQueue.global().async { _ = http("POST", "/api/send", ["from": "desk", "to": "*", "kind": "standup", "subject": subject, "body": body]) }
    }
    func notify(_ title: String, _ body: String) {
        let c = UNMutableNotificationContent(); c.title = title; c.body = body; c.sound = .default
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: c, trigger: nil))
    }

    // MARK: bells
    func bells() {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd HH:mm"
        let now = f.string(from: Date())
        let hm = String(now.suffix(5))
        let key = now
        if fired.contains(key) { return }
        switch hm {
        case "09:00":
            fired.insert(key); saveSet(fired, FIRED_PATH)
            post("STAND-UP 9:00 — one line each", "Done · next · blocked · needs Adam. One line. Reply to adam if you need him.")
            notify("Stand-up", waiting > 0 ? "\(waiting) waiting on you. Click the light." : "The crew is posting their lines. Click the light.")
        case "13:30":
            fired.insert(key); saveSet(fired, FIRED_PATH)
            if waiting > 0 { notify("1:30 nudge", "\(waiting) still waiting on you since this morning.") }
        case "18:00":
            fired.insert(key); saveSet(fired, FIRED_PATH)
            post("CLOSE 6:00 — what shipped", "What shipped today (receipt), what waits on Adam tomorrow. One line.")
            notify("Close of day", waiting > 0 ? "\(waiting) waiting on you before tomorrow." : "Nothing waits on you. Good day.")
        default: break
        }
        if fired.count > 200 { fired = Set(fired.sorted().suffix(50)); saveSet(fired, FIRED_PATH) }
    }
}

let app = NSApplication.shared
let desk = Desk()
app.delegate = desk
app.setActivationPolicy(.accessory)
app.run()
