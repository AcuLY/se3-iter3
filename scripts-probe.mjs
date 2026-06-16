import { Presentation } from 'file:///C:/Users/26552/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/@oai/artifact-tool/dist/artifact_tool.mjs';
const pres = Presentation.create(); const slide=pres.slides.add(); const shape=slide.shapes.add({ geometry:'rect' });
shape.position.set({left:100, top:100, width:300, height:100});
shape.fill.color = '#ff0000';
shape.line.color = '#000000';
shape.text.set('Hello');
console.log(JSON.stringify(shape.toProto()).slice(0,1200));
