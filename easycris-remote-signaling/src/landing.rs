use axum::response::Html;

pub fn invite_landing_html(invite_id: &str) -> Html<String> {
    let escaped_invite = html_escape(invite_id);
    Html(format!(
        r#"<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Open easyCris Remote Invite</title>
    <style>
      body {{
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #f8fafc;
        color: #111827;
      }}
      main {{
        width: min(540px, calc(100vw - 32px));
        border: 1px solid #dbe4ef;
        border-radius: 12px;
        background: white;
        padding: 24px;
        box-shadow: 0 20px 45px rgba(15, 23, 42, 0.08);
      }}
      h1 {{ font-size: 20px; margin: 0 0 8px; }}
      p {{ line-height: 1.5; color: #4b5563; }}
      code {{
        display: block;
        overflow-wrap: anywhere;
        border-radius: 8px;
        background: #f1f5f9;
        padding: 12px;
      }}
      [hidden] {{ display: none; }}
    </style>
  </head>
  <body>
    <main>
      <h1>Opening easyCris</h1>
      <p>The desktop app should open this remote invite automatically.</p>
      <section data-open-fallback hidden>
        <p>App did not open? Install easyCris, then copy this invite into the app.</p>
        <code data-copy-target></code>
      </section>
    </main>
    <script>
      const inviteId = "{escaped_invite}";
      const token = new URLSearchParams(location.hash.slice(1)).get("token") || "";
      const target = `easycris-remote://join?mode=cloud&invite=${{encodeURIComponent(inviteId)}}&token=${{encodeURIComponent(token)}}`;
      document.querySelector("[data-copy-target]").textContent = target;
      location.href = target;
      setTimeout(() => {{
        document.querySelector("[data-open-fallback]")?.removeAttribute("hidden");
        history.replaceState(null, "", location.pathname);
      }}, 1500);
    </script>
  </body>
</html>"#
    ))
}

fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
