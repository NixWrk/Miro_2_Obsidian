import { describe, expect, it } from "vitest";
import { ConnectorLayer } from "../src/connector-layer";

class Element {
  children: Element[] = [];
  attrs = new Map<string,string>();
  classList = {add: (..._names:string[])=>{}};
  constructor(readonly tag: string, readonly ownerDocument: FakeDocument) {}
  append(...children: Element[]) {this.children.push(...children);}
  replaceChildren() {this.children=[];}
  setAttribute(key:string,value:string) {this.attrs.set(key,value);}
  removeAttribute(key:string) {this.attrs.delete(key);}
  addEventListener() {}
  cloneNode() {const copy=new Element(this.tag,this.ownerDocument);copy.attrs=new Map(this.attrs);return copy;}
}
class FakeDocument {
  createElement(tag:string) {return new Element(tag,this);}
  createElementNS(_ns:string,tag:string) {return this.createElement(tag);}
}
const descendants=(element:Element):Element[]=>[element,...element.children.flatMap(descendants)];
function render(width:number, zoom:number, headSize?:number) {
  const root=new Element("div",new FakeDocument());
  let id=0;
  const layer=new ConnectorLayer(root as unknown as HTMLElement, {
    document:()=>({connectors:{a:{id:"a",from:{type:"free",x:0,y:0},to:{type:"free",x:100,y:0},
      route:"straight",color:"#123456",width,headSize,startCap:"arrow",endCap:"stealth"}}}),
    geometry:()=>({}),screen:p=>({x:p.x*zoom,y:p.y*zoom}),board:p=>p,
    landing:()=>undefined,editable:()=>true,write:()=>true,deselectNative:()=>{},id:()=>String(++id),
    clipboard:()=>{},removeSelection:()=>{},moveSelection:()=>false,selectionChanged:()=>{},
  });
  layer.render();
  return descendants(root).filter(e=>e.tag==="marker").map(e=>Object.fromEntries(e.attrs));
}
describe("connector layer head size",()=>{
  it("renders both heads independently of width and follows zoom",()=>{
    const thin=render(1,1,20), thick=render(50,1,20);
    expect(thin).toHaveLength(2);
    expect(thick).toEqual(thin);
    for(const marker of thin) expect(marker).toMatchObject({markerUnits:"userSpaceOnUse",markerWidth:"36",markerHeight:"32"});
    for(const marker of render(50,0.5,20)) expect(marker).toMatchObject({markerWidth:"18",markerHeight:"16"});
  });
  it("keeps the legacy stroke-relative defaults when size is absent",()=>{
    for(const marker of render(2,2)) {
      expect(marker).toMatchObject({markerWidth:"14",markerHeight:"14"});
      expect(marker.markerUnits).toBeUndefined();
    }
  });
});
