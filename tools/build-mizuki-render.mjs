import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
const root=process.cwd();
for(const [source,target]of[['app.js','mizukiNativeApp.js'],['drag.js','mizukiNativeDrag.js']]){
 const file=path.join(root,'public/js/render',source),raw=fs.readFileSync(file,'utf8');
 let text=raw.replace(/(from\s+|import\s*\()(['"])(\.{1,2}\/[^'"]+)\2/g,(_,prefix,quote,spec)=>prefix+quote+new URL(spec,'http://local/js/render/'+source).pathname+quote);
 text=text.replace(/import \{ GEO, ANIM \} from '[^']+';/,"import { ANIM } from '/shared/constants.js';\nimport { MIZUKI_GEO as GEO } from './mizukiPrep.js';");
 text=text.replace(/import \{ GEO \} from '[^']+';/,"import { MIZUKI_GEO as GEO } from './mizukiPrep.js';");
 text=text.replace("from '/js/render/drag.js'","from './mizukiNativeDrag.js'");
 if(source==='app.js') text=text.replace("import { loadImageElement } from '/js/assets.js';", "import { loadMizukiLocalImage as loadImageElement } from './mizukiAssets.js';");
 if(source==='app.js') text=text.replace("if (range) t = t.filter(([r]) => r !== GEO.HAND_ROW && r !== GEO.TEMP_ROW);", "if (range && mode === 'prep') t = t.filter(([r]) => r !== GEO.HAND_ROW && r !== GEO.TEMP_ROW);");
 // RO2 opening enemies have exact zero-time map previews; the ordinary boss
 // pen must not also place its composition-only leader on the same map.
 if(source==='app.js') text=text.replace("const stand = leaderStand(list, (k) => data.enemy(k)?.hitArea ?? null, hitTiles);", "const stand = null; // RO2 map enemies come only from authoritative prepEnemies.");
 if(source==='app.js') text=text.replace("if (!tile || !Number.isInteger(tile.row) || !Number.isInteger(tile.col)) { held.delete(uid); return true; }", `if (!tile || !Number.isInteger(tile.row) || !Number.isInteger(tile.col)) {
        const released = held.delete(uid);
        // Acknowledged moves may arrive while the direction preview holds the
        // piece. Release to the latest prep state, including its committed dir;
        // cancellation also restores the original slot instead of a stale ghost.
        if (released && mode === 'prep' && lastPrep) {
          setPrep(lastPrep.ps, lastPrep.o);
          const piece = prepPieces.find(value => value.uid === uid);
          if (piece && piece.area !== 'board') views.get('p:' + uid)?.setDir?.('RIGHT');
        }
        return true;
      }`);
 if(source==='app.js') text=text.replace("import { Camera, presetCamera, lerpCamera, easeInOutCubic, pickTile, normRect } from '/js/render/projection.js';", "import { Camera, lerpCamera, easeInOutCubic, pickTile, normRect } from '/js/render/projection.js';\nimport { mizukiPresetCamera as presetCamera } from './mizukiProjection.js';");
 if(source==='app.js') text=text.replace("v = info.kind === 'device' ? new DeviceView(ctx, info) : new UnitView(ctx, info, { prep: !!battleMeta?.prep && info.side === 'ally' });", "v = ctx.mizukiFacilityFactory?.(info) || (info.kind === 'device' ? new DeviceView(ctx, info) : new UnitView(ctx, info, { prep: !!battleMeta?.prep && info.side === 'ally' }));");
 if(source==='app.js') text=text.replace('  };\n  const onPointerMove = (e) => {', "    if (mode === 'prep') { const tile = groundTile(ev.x, ev.y); if (tile) emit('tileClick', { row:tile.row, col:tile.col }); }\n  };\n  const onPointerMove = (e) => {");
 fs.writeFileSync(path.join(root,'public/js',target),'// Generated from native render/'+source+'; source SHA256 '+createHash('sha256').update(raw).digest('hex')+'\n// Rebuild: node tools/build-mizuki-render.mjs. Only mode geometry/import ownership differs.\n'+text);
}
{
 const source='ui/facingWheel.js',file=path.join(root,'public/js',source),raw=fs.readFileSync(file,'utf8');
 let text=raw.replace(/(from\s+|import\s*\()(['"])(\.{1,2}\/[^'"]+)\2/g,(_,prefix,quote,spec)=>prefix+quote+new URL(spec,'http://local/js/'+source).pathname+quote);
 text=text.replace('normDir, boardDir, viewMirrored','normDir, boardDir as nativeBoardDir, viewMirrored');
 text="import { mizukiVerticalDirection } from './mizukiCoordinates.js';\nconst boardDir = (dir, mirror) => mizukiVerticalDirection(nativeBoardDir(dir, mirror));\n"+text;
 fs.writeFileSync(path.join(root,'public/js/mizukiFacingWheel.js'),'// Generated from native ui/facingWheel.js; source SHA256 '+createHash('sha256').update(raw).digest('hex')+'\n// Rebuild: node tools/build-mizuki-render.mjs. Only mode-local vertical direction differs.\n'+text);
}
