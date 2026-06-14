import { writeFile } from 'node:fs/promises';
import { Presentation, PresentationFile } from 'file:///C:/Users/26552/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/@oai/artifact-tool/dist/artifact_tool.mjs';
const pres = Presentation.create(); const slide=pres.slides.add(); const shape=slide.shapes.add({ geometry:'rect' }); shape.position.set({left:0,top:0,width:960,height:540}); shape.fill.color='#FFFFFF'; shape.text.set('Test');
const result = await PresentationFile.exportPptx(pres);
console.log('mime', result.mime, 'data', result.data?.constructor?.name, typeof result.data, Object.keys(result.data || {}).slice(0,10));
const data = result.data instanceof Uint8Array ? result.data : result.data?.arrayBuffer ? new Uint8Array(await result.data.arrayBuffer()) : result.data?.buffer ? new Uint8Array(result.data.buffer) : null;
console.log('data ready', !!data, data?.length);
if (data) await writeFile('D:/Luca/Assignment/se-3/iter3/outputs/manual-20260614/presentations/defense/output/test.pptx', data);
