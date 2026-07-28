// Hardcoded copies of globals.css's light-theme tokens -- email clients
// don't run our CSS (no custom properties, often no <style> at all), and
// email always renders on a light background regardless of the
// recipient's OS theme, so this deliberately doesn't try to track the
// site's dark mode. Table-based layout, not flex/grid -- still the safe
// baseline across Outlook/Gmail/Apple Mail's wildly inconsistent CSS
// support in a way flex isn't.
const INK = "#201d1d";
const MUTED = "#646262";
const CANVAS = "#fdfcfc";
const SURFACE = "#f1eeee";
const BORDER = "rgba(15,0,0,0.12)";
// Single-quoted font names, not double -- every consumer below interpolates
// this into an HTML style="..." attribute that's itself double-quoted;
// double-quoted font names here would terminate that attribute early at
// the first embedded quote and silently truncate the whole style string.
const FONT_STACK = "'IBM Plex Mono','SFMono-Regular',Menlo,Monaco,Consolas,'Liberation Mono','Courier New',monospace";

export function renderEmail(params: { preheader: string; bodyHtml: string }): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:${SURFACE};font-family:${FONT_STACK};">
  <!-- Preheader: hidden preview text, not visible in the rendered email itself -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${params.preheader}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${SURFACE};padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:${CANVAS};border:1px solid ${BORDER};">
          <tr>
            <td style="padding:20px 32px;border-bottom:1px solid ${BORDER};">
              <a href="https://gntai.dev" style="font-family:${FONT_STACK};font-size:14px;font-weight:700;color:${INK};text-decoration:none;">
                <span style="color:${MUTED};">[</span>gnt.ai<span style="color:${MUTED};">]</span>
              </a>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              ${params.bodyHtml}
            </td>
          </tr>
        </table>
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;">
          <tr>
            <td style="padding:16px 32px;">
              <a href="https://gntai.dev" style="font-family:${FONT_STACK};font-size:12px;color:${MUTED};text-decoration:none;">gnt.ai</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function paragraph(text: string): string {
  return `<p style="margin:0 0 16px;font-family:${FONT_STACK};font-size:14px;line-height:1.6;color:${INK};">${text}</p>`;
}

export function mutedParagraph(text: string): string {
  return `<p style="margin:0;font-family:${FONT_STACK};font-size:13px;line-height:1.6;color:${MUTED};">${text}</p>`;
}

// The 6-digit code, styled to echo AuthScreen's own code-input treatment
// (bordered box, wide letter-spacing, centered) rather than plain inline text.
export function codeBox(code: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px;">
  <tr>
    <td align="center" style="background:${SURFACE};border:1px solid ${BORDER};padding:16px;">
      <span style="font-family:${FONT_STACK};font-size:28px;font-weight:700;letter-spacing:8px;color:${INK};">${code}</span>
    </td>
  </tr>
</table>`;
}

// button-primary from the design system: ink fill, cream text, 4px radius.
export function button(label: string, href: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0">
  <tr>
    <td style="background:${INK};border-radius:4px;">
      <a href="${href}" style="display:inline-block;padding:10px 24px;font-family:${FONT_STACK};font-size:14px;font-weight:500;color:${CANVAS};text-decoration:none;">${label}</a>
    </td>
  </tr>
</table>`;
}
