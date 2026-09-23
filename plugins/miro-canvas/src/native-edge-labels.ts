/** Screen-space labels for native edges whose routes the plugin reshapes. */
import { pointOnPolyline, type AnchorPoint } from "./anchors";
import { nearestRouteFraction } from "./board-connectors";

export interface NativeEdgeLabel {
  id:string;
  text:string;
  points:readonly AnchorPoint[];
  t:number;
  native?:HTMLElement|SVGElement;
}

interface Host {
  move(id:string,t:number):void;
  edit(id:string,text:string):void;
  editable(id:string):boolean;
}

/** One route-bound label interaction for every native edge, including blank labels. */
export class NativeEdgeLabels {
  readonly element:HTMLDivElement;
  private entries=new Map<string,{button:HTMLButtonElement;native?:HTMLElement|SVGElement;visibility?:string;item:NativeEdgeLabel}>();
  private previews=new Map<string,readonly AnchorPoint[]>();
  private dragging?:string;
  private editing?:HTMLInputElement;
  constructor(private root:HTMLElement,private host:Host){
    this.element=root.ownerDocument.createElement("div");
    this.element.className="miro-canvas-native-edge-labels";
    root.appendChild(this.element);
  }
  update(items:readonly NativeEdgeLabel[]):void {
    const wanted=new Set(items.map(item=>item.id));
    for(const [id,entry] of this.entries)if(!wanted.has(id))this.remove(id);
    const rect=this.root.getBoundingClientRect();
    for(const item of items){
      let entry=this.entries.get(item.id);
      if(entry&&entry.native!==item.native){this.remove(item.id);entry=undefined;}
      if(!entry){
        const button=this.root.ownerDocument.createElement("button");
        button.type="button";button.className="miro-canvas-native-edge-label";
        button.addEventListener("pointerdown",event=>this.drag(event,item.id));
        button.addEventListener("dblclick",event=>{event.preventDefault();event.stopImmediatePropagation();this.edit(item.id);});
        this.element.appendChild(button);
        entry={button,native:item.native,visibility:item.native?.style.visibility,item};
        this.entries.set(item.id,entry);
        if(item.native)item.native.style.visibility="hidden";
      }
      entry.item=item;
      entry.button.textContent=item.text;
      entry.button.hidden=!item.text;
      entry.button.setAttribute("aria-label",`Drag edge label; double-click to edit: ${item.text}`);
      if(this.dragging===item.id)continue;
      const at=pointOnPolyline(this.previews.get(item.id)??item.points,item.t);
      if(at){entry.button.style.left=`${at.x-rect.left}px`;entry.button.style.top=`${at.y-rect.top}px`;}
    }
  }
  /** A bend preview moves the existing label before the pointer is released. */
  preview(id:string,points:readonly AnchorPoint[]):void {
    this.previews.set(id,points);
    const entry=this.entries.get(id),at=entry&&pointOnPolyline(points,entry.item.t);
    if(!entry||!at)return;
    const rect=this.root.getBoundingClientRect();
    entry.button.style.left=`${at.x-rect.left}px`;entry.button.style.top=`${at.y-rect.top}px`;
  }
  clearPreview(id:string):void {
    this.previews.delete(id);
    const entry=this.entries.get(id),at=entry&&pointOnPolyline(entry.item.points,entry.item.t);
    if(!entry||!at)return;
    const rect=this.root.getBoundingClientRect();
    entry.button.style.left=`${at.x-rect.left}px`;entry.button.style.top=`${at.y-rect.top}px`;
  }
  private drag(event:PointerEvent,id:string):void {
    if(event.button!==0||!this.host.editable(id))return;
    const entry=this.entries.get(id),view=this.root.ownerDocument.defaultView;
    if(!entry||!view)return;
    event.preventDefault();event.stopPropagation();
    this.dragging=id;let t=entry.item.t,changed=false;
    const move=(e:PointerEvent)=>{
      if(e.pointerId!==event.pointerId)return;
      changed ||= Math.hypot(e.clientX-event.clientX,e.clientY-event.clientY)>3;
      if(!changed)return;
      t=nearestRouteFraction(entry.item.points,{x:e.clientX,y:e.clientY});
      const at=pointOnPolyline(entry.item.points,t),rect=this.root.getBoundingClientRect();
      if(at){entry.button.style.left=`${at.x-rect.left}px`;entry.button.style.top=`${at.y-rect.top}px`;}
    };
    const cleanup=()=>{view.removeEventListener("pointermove",move,true);view.removeEventListener("pointerup",up,true);view.removeEventListener("pointercancel",cancel,true);this.dragging=undefined;};
    const cancel=()=>{
      cleanup();const at=pointOnPolyline(entry.item.points,entry.item.t),rect=this.root.getBoundingClientRect();
      if(at){entry.button.style.left=`${at.x-rect.left}px`;entry.button.style.top=`${at.y-rect.top}px`;}
    };
    const up=(e:PointerEvent)=>{if(e.pointerId!==event.pointerId)return;move(e);cleanup();if(changed)this.host.move(id,t);};
    view.addEventListener("pointermove",move,true);view.addEventListener("pointerup",up,true);view.addEventListener("pointercancel",cancel,true);
  }
  edit(id:string):boolean {
    const entry=this.entries.get(id);if(!entry||!this.host.editable(id))return false;
    this.editing?.remove();
    const input=this.root.ownerDocument.createElement("input");
    input.className="miro-canvas-native-edge-label-editor";input.type="text";input.maxLength=1024;
    input.value=entry.item.text;input.setAttribute("aria-label","Edge label");
    input.style.left=entry.button.style.left;input.style.top=entry.button.style.top;
    this.element.appendChild(input);this.editing=input;
    let done=false;
    const finish=(save:boolean)=>{if(done)return;done=true;input.remove();if(this.editing===input)this.editing=undefined;if(save&&input.value!==entry.item.text)this.host.edit(id,input.value);};
    input.addEventListener("pointerdown",e=>e.stopPropagation());
    input.addEventListener("keydown",e=>{e.stopPropagation();if(e.key==="Enter"){e.preventDefault();finish(true);}else if(e.key==="Escape"){e.preventDefault();finish(false);}});
    input.addEventListener("blur",()=>finish(true));input.focus();input.select();
    return true;
  }
  private remove(id:string):void {
    const entry=this.entries.get(id);if(!entry)return;
    this.previews.delete(id);
    if(entry.native)entry.native.style.visibility=entry.visibility??"";
    entry.button.remove();this.entries.delete(id);
  }
  dispose():void {for(const id of [...this.entries.keys()])this.remove(id);this.editing?.remove();this.element.remove();}
}
