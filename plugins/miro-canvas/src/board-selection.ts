import { boardConnectors, translateConnector } from "./board-connectors";
import type { AnchorPoint } from "./anchors";

/** Segment clipping also catches a line crossing a box with both ends outside. */
export function routeIntersectsBox(points: readonly AnchorPoint[], a: AnchorPoint, b: AnchorPoint): boolean {
  const left=Math.min(a.x,b.x),right=Math.max(a.x,b.x),top=Math.min(a.y,b.y),bottom=Math.max(a.y,b.y);
  const inside=(p:AnchorPoint)=>p.x>=left&&p.x<=right&&p.y>=top&&p.y<=bottom;
  if(points.some(inside))return true;
  for(let i=1;i<points.length;i++){
    const start=points[i-1]!,end=points[i]!;let lo=0,hi=1;
    for(const [origin,delta,min,max] of [[start.x,end.x-start.x,left,right],[start.y,end.y-start.y,top,bottom]]){
      if(delta===0){if(origin!<min!||origin!>max!){lo=1;hi=0;break;}continue;}
      const first=(min!-origin!)/delta!,last=(max!-origin!)/delta!;
      lo=Math.max(lo,Math.min(first,last));hi=Math.min(hi,Math.max(first,last));
    }
    if(lo<=hi)return true;
  }
  return false;
}

/** Detached preview and commit share the same geometry; source records stay untouched. */
export function translateBoardSelection(document: Record<string, unknown>, ids: readonly string[], dx: number, dy: number): Record<string, unknown> {
  const next=JSON.parse(JSON.stringify(document)) as Record<string, any>;
  const selected=new Set(ids);
  for(const node of next.nodes ?? []) if(selected.has(node.id)){node.x+=dx;node.y+=dy;}
  const connectors=boardConnectors(next);
  for(const c of connectors) if(selected.has(c.id)) next.miroCanvas.connectors[c.id]=translateConnector(c,dx,dy);
  // Native route control points are absolute board coordinates as well.
  for(const edge of next.edges ?? []) if(selected.has(edge.id)||selected.has(edge.fromNode)&&selected.has(edge.toNode)) {
    const override=next.miroCanvas?.localOverrides?.[edge.id];
    if(override?.connector?.waypoints) override.connector.waypoints=override.connector.waypoints.map((p:{x:number;y:number})=>({x:p.x+dx,y:p.y+dy}));
    for(const end of ["from","to"]) {
      const anchor=override?.connectorAnchors?.[end];
      if(anchor?.type==="free"){anchor.x+=dx;anchor.y+=dy;}
    }
  }
  return next;
}
