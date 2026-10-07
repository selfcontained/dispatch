// Minimal system-WebKit host for wk-probe.mjs: a real window with a
// WKWebView, so the page gets Safari's engine and compositing (Playwright's
// WebKit build does not allocate graphics memory the same way). Reads one
// command per line on stdin and answers on stdout:
//   load <url>     navigate
//   js <body>      run an async function body, print "RESULT <value>"
//   quit
// Build: swiftc -O wkhost.swift -o /tmp/wkhost
import Cocoa
import WebKit

class Delegate: NSObject, NSApplicationDelegate {
  var window: NSWindow!
  var web: WKWebView!
  func applicationDidFinishLaunching(_ n: Notification) {
    let cfg = WKWebViewConfiguration()
    cfg.websiteDataStore = .nonPersistent()
    web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1440, height: 900), configuration: cfg)
    window = NSWindow(contentRect: NSRect(x: 40, y: 40, width: 1440, height: 900),
                      styleMask: [.titled, .resizable], backing: .buffered, defer: false)
    window.contentView = web
    window.title = "wkhost memory probe"
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    print("READY"); fflush(stdout)
    DispatchQueue.global().async { self.readLoop() }
  }
  func readLoop() {
    while let line = readLine() {
      let parts = line.split(separator: " ", maxSplits: 1).map(String.init)
      guard let cmd = parts.first else { continue }
      let arg = parts.count > 1 ? parts[1] : ""
      let sem = DispatchSemaphore(value: 0)
      DispatchQueue.main.async {
        switch cmd {
        case "load":
          self.web.load(URLRequest(url: URL(string: arg)!))
          print("OK"); fflush(stdout); sem.signal()
        case "js":
          self.web.callAsyncJavaScript(arg, arguments: [:], in: nil, in: .page) { r in
            switch r {
            case .success(let v): print("RESULT \(v)")
            case .failure(let e): print("ERROR \(e)")
            }
            fflush(stdout); sem.signal()
          }
        case "quit":
          NSApp.terminate(nil)
        default:
          print("?"); fflush(stdout); sem.signal()
        }
      }
      sem.wait()
    }
    DispatchQueue.main.async { NSApp.terminate(nil) }
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let d = Delegate()
app.delegate = d
app.run()
