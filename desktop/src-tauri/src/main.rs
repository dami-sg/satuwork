#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::menu::{Menu, MenuItem, Submenu};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

/**
 * Satuwork 桌面壳。
 *
 * **它不装前端。** 界面还是 Gateway 那一份（gateway/ui），由 Gateway 自己发；这个壳
 * 做的事只有一件：把一个没有地址栏的窗口指到那台 Gateway 上。
 *
 * 为什么不把 ui 打进包里——那样每一条 fetch 都成了跨源请求，Gateway 要加 CORS，而
 * 真正会当场坏掉的是对话页右栏那块桌面：它那张 `satu_desk_*` 是 SameSite=Lax 的
 * cookie，跨源之后浏览器连存都不存（见 gateway/src/desktop.ts 开头那段）。同源是
 * 那条路唯一的前提，而「直接装远端页面」是保住同源最便宜的办法。
 *
 * 代价说清楚：没网就是一片空白，打开必须连得到 Gateway。这不亏——这个界面本来就
 * 没有一屏是离线能用的。换来的是前端**永远不会**和服务端版本漂开。
 *
 * 包里唯一的页面是 shell/index.html——「连哪台 Gateway」那一屏。它是本地资源，所以
 * 能调下面这几个命令；主窗口装的是远端页面，不在任何 capability 名单里，一个命令都
 * 拿不到（拦它的是 ACL，不是「注入没注入」——`__TAURI_INTERNALS__` 在哪个窗口里都在）。
 */

const SETUP: &str = "setup";
const MAIN: &str = "main";
const SWITCH_ITEM: &str = "switch-server";

/**
 * 「请帮我在外面打开这个地址」的暗号。
 *
 * 走的是一条**同源的普通 http 路径**，不是自定义协议——自定义协议在各家 webview 里
 * 会不会走到导航回调，是要一个个试的；同源路径一定会。Gateway 不认这个路径，但它也
 * 永远走不到 Gateway：导航回调在同源判断**之前**就把它截下来了。
 */
const OPEN_PATH: &str = "/__satuwork_open";

/** 新开的窗口编号。同一个 label 开第二次会失败，所以每开一扇加一。 */
static EXTRA: AtomicUsize = AtomicUsize::new(0);

/** 启动时那句「为什么没直接进去」。设置屏起来之后自己来取。 */
#[derive(Default)]
struct Startup(Mutex<String>);

/** 地址落磁盘。一台机器一个人用，没必要进 keychain——它不是凭据，只是个地址。 */
fn server_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join("server.txt"))
}

/**
 * 这次该连哪儿。
 *
 * `SATUWORK_SERVER` **只覆盖，不写盘**：它是给开发和排查用的，跑完一次不该改掉用户
 * 存着的那个地址。
 */
fn read_server(app: &AppHandle) -> Option<String> {
    if let Ok(from_env) = std::env::var("SATUWORK_SERVER") {
        let s = from_env.trim().to_string();
        if !s.is_empty() {
            return Some(s);
        }
    }
    let raw = fs::read_to_string(server_file(app)?).ok()?;
    let s = raw.trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

fn write_server(app: &AppHandle, url: &str) -> Result<(), String> {
    let path = server_file(app).ok_or("找不到配置目录")?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("建配置目录失败：{e}"))?;
    }
    fs::write(path, url).map_err(|e| format!("写配置失败：{e}"))
}

/**
 * 人手打的地址得能用。`gw.example.com`、`192.168.1.10:3080` 这种不带协议的最常见，
 * 一律当 http 补上——内网部署本来就是 http（Gateway 自己也按这个假设发 cookie）。
 *
 * 只认 http/https：别的协议进到 WebviewUrl::External 里就是一扇没人审过的门。
 */
fn normalize(raw: &str) -> Result<Url, String> {
    let s = raw.trim();
    if s.is_empty() {
        return Err("请填 Gateway 地址".into());
    }
    let with_scheme = if s.contains("://") { s.to_string() } else { format!("http://{s}") };
    let url = Url::parse(&with_scheme).map_err(|e| format!("这个地址读不懂：{e}"))?;
    match url.scheme() {
        "http" | "https" => {}
        other => return Err(format!("只认 http 和 https，不认 {other}")),
    }
    if url.host_str().unwrap_or("").is_empty() {
        return Err("地址里没有主机名".into());
    }
    Ok(url)
}

/**
 * 打开之前先敲一下门。
 *
 * **不敲的话，连不上的表现是一片空白。** WKWebView 没有内建的错误页，装不上东西时
 * 窗口里一个字都没有——和「服务器正在重启」「地址打错一个字母」「公司 VPN 没连」
 * 长得一模一样，而人在这三种情况下要做的事完全不同。
 *
 * 只到 TCP 为止：解析得了域名、连得上端口就算数。**它证明不了那头是 Gateway**——
 * 端口通着但服务 500、或者连到了另一个服务，这里都看不出来。要的只是把最常见的那
 * 几种「白窗口」翻译成一句人话，不是健康检查。
 */
fn reachable(url: &Url) -> Result<(), String> {
    let host = url.host_str().unwrap_or("").to_string();
    let port = url.port_or_known_default().unwrap_or(80);
    let addrs = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|e| format!("解析不了 {host}：{e}"))?;
    let mut last = String::from("没有可用地址");
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, Duration::from_secs(3)) {
            Ok(_) => return Ok(()),
            Err(e) => last = e.to_string(),
        }
    }
    Err(format!("连不上 {host}:{port}（{last}）"))
}

fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

/**
 * 装在远端页面里的一小段：**把「开新窗口」翻译成一次导航**。
 *
 * 起因是实测出来的一件事：`target="_blank"` 的链接和 `window.open()` 在这个 webview
 * 里都是**空操作**——不报错、不开窗、连请求都不发。而 gateway/ui 的外链一律带
 * `target="_blank"`（markdown.js 渲染的每个链接、chat.js 那个「打开桌面」按钮），
 * 于是在桌面端它们全部变成了点不动的死链，界面上还没有任何提示。
 *
 * 这段脚本把它们改写成一次到 OPEN_PATH 的普通导航，交给 Rust 那边分流：同源的另开
 * 一扇应用窗口，站外的交给系统浏览器。
 *
 * **不改同源的普通链接**——那是页面自己的路由，改了等于把界面拆了。
 */
const LINK_SCRIPT: &str = r#"
(function () {
  if (window.__satuLinkPatched) return
  window.__satuLinkPatched = true
  function hand(raw) {
    try {
      var abs = new URL(raw, location.href).href
      location.href = location.origin + '__OPEN_PATH__?u=' + encodeURIComponent(abs)
    } catch (e) {}
  }
  var open0 = window.open
  window.open = function (u) {
    if (u) hand(String(u))
    return null
  }
  document.addEventListener(
    'click',
    function (e) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey) return
      var el = e.target
      var a = el && el.closest ? el.closest('a[target="_blank"]') : null
      if (!a || !a.href) return
      e.preventDefault()
      hand(a.href)
    },
    true,
  )
})()
"#;

/**
 * 每一次导航都过这里。
 *
 * 要挡的**只有一件事**：把唯一的窗口导航到站外。这个壳没有地址栏也没有后退，页面
 * 一旦跳出去，人就被关在一个回不来的地方了（只剩菜单里那条「切换服务器…」）。
 *
 * 所以按 scheme 分流：**不是 http/https 的一律放行**。第一版是「白名单 + 同源」，
 * 而白名单永远漏得掉——`blob:`（附件预览喂给 iframe 的那个）漏了就是预览白屏，
 * `ws:` 漏了就是桌面没画面，而同源比较里 `ws` 和 `http` 本来就不是同一个字。
 *
 * 拦这些也拦不住什么：页面里的 JS 想连哪儿就能连哪儿，这条回调不是它的边界。
 * 它是「窗口跑没跑掉」的边界，仅此而已。
 */
fn allow_navigation(app: &AppHandle, base: &Url, url: &Url) -> bool {
    match url.scheme() {
        "http" | "https" => {}
        _ => return true,
    }
    if same_origin(url, base) {
        if url.path() == OPEN_PATH {
            route_open(app, base, url);
            return false;
        }
        return true;
    }
    let _ = app.opener().open_url(url.as_str(), None::<&str>);
    false
}

/** 暗号里带的那个地址：同源的另开一扇应用窗口，站外的交给系统浏览器。 */
fn route_open(app: &AppHandle, base: &Url, url: &Url) {
    let target = url
        .query_pairs()
        .find(|(k, _)| k == "u")
        .map(|(_, v)| v.to_string())
        .unwrap_or_default();
    let Ok(parsed) = Url::parse(&target) else { return };
    match parsed.scheme() {
        "http" | "https" => {}
        // 暗号是页面递过来的，页面上的内容不全是我们写的（markdown 里的链接来自模型
        // 和用户）。只有 http/https 往下走，别的一律当没发生。
        _ => return,
    }
    if same_origin(&parsed, base) {
        let label = format!("extra-{}", EXTRA.fetch_add(1, Ordering::Relaxed));
        let _ = build_window(app, &label, parsed, base.clone(), "Satuwork");
    } else {
        let _ = app.opener().open_url(parsed.as_str(), None::<&str>);
    }
}

/** 装远端页面的窗口都从这儿出：同一套导航守卫，同一段链接脚本。 */
fn build_window(
    app: &AppHandle,
    label: &str,
    url: Url,
    base: Url,
    title: &str,
) -> tauri::Result<()> {
    let handle = app.clone();
    WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .title(title)
        .inner_size(1280.0, 860.0)
        .min_inner_size(960.0, 600.0)
        .initialization_script(&LINK_SCRIPT.replace("__OPEN_PATH__", OPEN_PATH))
        .on_navigation(move |url| allow_navigation(&handle, &base, url))
        .build()?;
    Ok(())
}

fn open_main(app: &AppHandle, url: Url) -> tauri::Result<()> {
    if let Some(win) = app.get_webview_window(MAIN) {
        win.set_focus()?;
        return Ok(());
    }
    build_window(app, MAIN, url.clone(), url, "Satuwork")
}

fn open_setup(app: &AppHandle) -> tauri::Result<()> {
    if let Some(win) = app.get_webview_window(SETUP) {
        win.set_focus()?;
        return Ok(());
    }
    WebviewWindowBuilder::new(app, SETUP, WebviewUrl::App("index.html".into()))
        .title("连接 Satuwork")
        .inner_size(520.0, 460.0)
        .resizable(false)
        .build()?;
    Ok(())
}

#[tauri::command]
fn current_server(app: AppHandle) -> String {
    read_server(&app).unwrap_or_default()
}

/** 启动时没能直接进去的原因。取一次就清掉——它说的是「刚才」，不是「现在」。 */
#[tauri::command]
fn startup_error(app: AppHandle) -> String {
    let state = app.state::<Startup>();
    let mut slot = state.0.lock().unwrap();
    std::mem::take(&mut *slot)
}

/**
 * 连。**连不上就不写盘**——写了的话下次启动会直接奔那个地址去，而那正是「白窗口」
 * 的来源；停在这一屏、把话说清楚，人还在键盘前面，改一个字母就好了。
 */
#[tauri::command]
fn connect(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = normalize(&url)?;
    reachable(&parsed)?;
    write_server(&app, parsed.as_str())?;
    open_main(&app, parsed).map_err(|e| e.to_string())?;
    if let Some(win) = app.get_webview_window(SETUP) {
        let _ = win.close();
    }
    Ok(())
}

/**
 * 菜单里那一条「切换服务器…」。
 *
 * **少了它这个壳会砖。** 地址填对了但那台机器换了地方、或者页面被导航到了一个回不来
 * 的地方，界面上又没有地址栏可以改——人只能去删配置文件，而没人知道那个路径。
 *
 * 从系统默认菜单接着加：macOS 上复制粘贴的快捷键是菜单项给的，自己从空菜单搭一份
 * 就等于把 Cmd+C/Cmd+V 弄没了。
 */
fn install_menu(app: &AppHandle) -> tauri::Result<()> {
    let menu = Menu::default(app)?;
    let switch = MenuItem::with_id(app, SWITCH_ITEM, "切换服务器…", true, None::<&str>)?;
    let submenu = Submenu::with_items(app, "服务器", true, &[&switch])?;
    menu.append(&submenu)?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        if event.id() != SWITCH_ITEM {
            return;
        }
        // 装着远端页面的窗口全关掉——包括「打开桌面」那种另开的。留着的话它们还指着
        // 老地址，而人正要换一台。
        for (label, win) in app.webview_windows() {
            if label != SETUP {
                let _ = win.close();
            }
        }
        let _ = open_setup(app);
    });
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(Startup::default())
        .invoke_handler(tauri::generate_handler![current_server, startup_error, connect])
        .setup(|app| {
            let handle = app.handle().clone();
            install_menu(&handle)?;
            // 存过地址、且那台机器现在敲得开，才直接进去。敲不开就回设置屏，并且把
            // 敲门的结果原样摆在上面。
            match read_server(&handle).and_then(|s| normalize(&s).ok()) {
                Some(url) => match reachable(&url) {
                    Ok(()) => open_main(&handle, url)?,
                    Err(why) => {
                        *handle.state::<Startup>().0.lock().unwrap() = format!("{why}");
                        open_setup(&handle)?
                    }
                },
                None => open_setup(&handle)?,
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Satuwork 桌面壳起不来")
}
