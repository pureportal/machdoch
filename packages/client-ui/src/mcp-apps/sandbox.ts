import {
  mcpAppCspSchema,
  type McpAppView,
} from "@machdoch/fleet-protocol/mcp-apps";

const attribute = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");

export function appContentPolicy(input: McpAppView["csp"]): string {
  const csp = mcpAppCspSchema.parse(input);
  const resources = csp.resourceDomains.join(" ");
  return `default-src 'none'; script-src 'unsafe-inline' ${resources}; style-src 'unsafe-inline' ${resources}; img-src data: ${resources}; font-src ${resources || "'none'"}; media-src data: ${resources}; connect-src ${csp.connectDomains.join(" ") || "'none'"}; frame-src ${csp.frameDomains.join(" ") || "'none'"}; base-uri ${csp.baseUriDomains.join(" ") || "'none'"}; object-src 'none'; form-action 'none'`;
}

export function sandboxProxyUrl(csp: McpAppView["csp"]): string {
  const policy = appContentPolicy(csp).replace(
    /frame-src [^;]+/u,
    `frame-src about: data: blob: ${csp.frameDomains.join(" ")}`,
  );
  const source = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${attribute(policy)}"><style>html,body,iframe{border:0;margin:0;width:100%;height:100%;display:block}</style><script>
let frame;
addEventListener("message",event=>{
 const message=event.data;
 if(!message||message.jsonrpc!=="2.0")return;
 if(event.source===parent){
  if(message.method==="ui/notifications/sandbox-resource-ready"){
   if(frame||typeof message.params?.html!=="string")return;
   frame=document.createElement("iframe");frame.sandbox="allow-scripts allow-same-origin";
   frame.setAttribute("allow","camera 'none'; microphone 'none'; geolocation 'none'; clipboard-write 'none'");
   frame.srcdoc=message.params.html;document.body.append(frame);
  }else if(!message.method?.startsWith("ui/notifications/sandbox-")){frame?.contentWindow.postMessage(message,"*");}
 }else if(frame&&event.source===frame.contentWindow&&!message.method?.startsWith("ui/notifications/sandbox-"))parent.postMessage(message,"*");
});
parent.postMessage({jsonrpc:"2.0",method:"ui/notifications/sandbox-proxy-ready",params:{}},"*");
</script><body></body>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(source)}`;
}

export function sandboxedAppHtml(view: McpAppView): string {
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${attribute(appContentPolicy(view.csp))}">${view.html}`;
}
