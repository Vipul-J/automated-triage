export const escapeHtml = (value: string): string =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );

export const TIER_COLOUR: Record<string, string> = {
  AUTO: "#0f7b3d",
  REVIEW: "#8a5a00",
  ASSIST: "#a14000",
  MANUAL: "#9b1b30",
};

export const PRIORITY_COLOUR: Record<number, string> = {
  1: "#9b1b30",
  2: "#c2410c",
  3: "#8a5a00",
  4: "#3f6212",
  5: "#475569",
};

const STYLES = `
:root{color-scheme:light dark;--bg:#f4f5f7;--fg:#1c1d21;--muted:#6b7280;--line:#dfe1e6;
      --card:#fff;--head:#1f2a44;--accent:#2563eb;}
@media (prefers-color-scheme:dark){:root{--bg:#14151a;--fg:#e8e9ec;--muted:#9aa0aa;
      --line:#2b2d35;--card:#1c1e25;--head:#0f1729;}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
     font:14px/1.5 -apple-system,"Segoe UI",system-ui,sans-serif}
header{background:var(--head);color:#fff;padding:10px 18px;display:flex;gap:18px;align-items:center}
header b{font-size:15px;letter-spacing:.01em}
header nav{display:flex;gap:4px;margin-left:auto;flex-wrap:wrap}
header a{color:#cbd5e1;text-decoration:none;padding:5px 11px;border-radius:5px;font-size:13px}
header a:hover{background:rgba(255,255,255,.1);color:#fff}
header a.on{background:var(--accent);color:#fff}
main{max-width:1060px;margin:0 auto;padding:20px 16px 60px}
h1{font-size:19px;margin:0 0 3px}
.lede{color:var(--muted);margin:0 0 18px;font-size:13px;max-width:70ch}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;margin-bottom:12px}
.pad{padding:14px 16px}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.num{font-family:ui-monospace,SFMono-Regular,monospace;font-weight:650;font-size:13px}
a.num{color:var(--accent);text-decoration:none}
a.num:hover{text-decoration:underline}
.chip{font-size:11px;font-weight:650;letter-spacing:.03em;padding:2px 7px;border-radius:4px;color:#fff}
.chip.ghost{background:transparent;color:var(--muted);border:1px solid var(--line);font-weight:500}
.clock{margin-left:auto;font-variant-numeric:tabular-nums;font-weight:650;font-size:13px}
.clock.warn{color:#b45309}.clock.crit{color:#b91c1c}
.sd{font-weight:600;margin:9px 0 2px;font-size:15px}
.why{border-left:3px solid var(--line);padding:2px 0 2px 10px;margin:10px 0;font-size:13px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(215px,1fr));gap:0 22px}
.f{padding:6px 0;border-bottom:1px solid var(--line);font-size:13px}
.f span{display:block;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.05em}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;color:var(--muted);font-size:11px;text-transform:uppercase;
   letter-spacing:.05em;padding:8px 10px;border-bottom:1px solid var(--line);font-weight:600}
td{padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:0}
textarea{width:100%;min-height:76px;padding:8px;border:1px solid var(--line);border-radius:5px;
         background:var(--bg);color:var(--fg);font:inherit;resize:vertical}
button{font:inherit;font-size:13px;padding:6px 12px;border-radius:5px;border:1px solid var(--line);
       background:var(--card);color:var(--fg);cursor:pointer}
button:hover{border-color:var(--muted)}
button.go{background:#15803d;border-color:#15803d;color:#fff;font-weight:600}
.acts{display:flex;gap:7px;flex-wrap:wrap;margin-top:10px}
.j{border-left:3px solid var(--line);padding:3px 0 3px 11px;margin:12px 0}
.j.work{border-color:#8a5a00}.j.cmt{border-color:#2563eb}
.j pre{margin:5px 0 0;white-space:pre-wrap;font:12px/1.5 ui-monospace,monospace;color:var(--fg)}
.j .meta{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.04em}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:18px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:13px 15px}
.stat b{display:block;font-size:25px;line-height:1.15;font-weight:680}
.stat span{color:var(--muted);font-size:12px}
.ok{color:#15803d}.bad{color:#b91c1c}.warnc{color:#b45309}
.empty{color:var(--muted);padding:26px 0;text-align:center}
.note{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--accent);
      border-radius:6px;padding:11px 14px;margin:14px 0;font-size:13px;color:var(--muted)}
@media(max-width:620px){.clock{margin-left:0;width:100%}}
`;

export function page(args: {
  title: string;
  active: "overview" | "l1" | "l2" | "incident";
  body: string;
  live?: boolean;
}): string {
  const nav = (href: string, key: string, label: string) =>
    `<a href="${href}" class="${args.active === key ? "on" : ""}">${label}</a>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(args.title)}</title><style>${STYLES}</style></head><body>
<header><b>Service Desk — AI Triage</b><nav>
${nav("/", "overview", "Overview")}
${nav("/l1", "l1", "L1 queue")}
${nav("/l2", "l2", "L2 queue")}
</nav></header>
<main>${args.body}</main>
<script>
function tick(){
  for(const el of document.querySelectorAll("[data-sla]")){
    const left=Math.max(0,Math.floor((+el.dataset.sla-Date.now())/1000));
    if(el.dataset.done==="1"){continue}
    el.textContent = left>0
      ? Math.floor(left/60)+":"+String(left%60).padStart(2,"0")+" to SLA breach"
      : "SLA breached";
    el.classList.toggle("warn",left<=90&&left>30);
    el.classList.toggle("crit",left<=30);
  }
}
setInterval(tick,1000);tick();
async function decide(number,action,group,level){
  const card=document.getElementById("c-"+number);
  const body={action,actor:card?.dataset.actor||"l1.engineer",
              actorRole:card?.dataset.role||"L1",
              clientResponse:card?.querySelector("textarea")?.value};
  if(group){body.team=group;body.level=level}
  const r=await fetch("/api/incidents/"+number+"/decision",
    {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  if(!r.ok){alert("Rejected: "+(await r.text()))}
}
${args.live ? `new EventSource("/events").onmessage=()=>location.reload();` : ""}
</script></body></html>`;
}
