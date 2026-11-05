import { registerHooks } from 'node:module';
import fs from 'node:fs'; import { fileURLToPath } from 'node:url';
registerHooks({ resolve(spec, ctx, next){
  if (spec.endsWith('.js') && (spec.startsWith('.')||spec.startsWith('file:')) && ctx.parentURL) {
    const u=new URL(spec,ctx.parentURL); const ts=u.href.replace(/\.js$/,'.ts');
    if (fs.existsSync(fileURLToPath(ts))) return next(ts,ctx);
  }
  return next(spec,ctx);
}});
