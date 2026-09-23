import { boardConnectors, translateConnector } from "./board-connectors";
import { normalizeAnchor, type AnchorPoint } from "./anchors";
import { buildCanvasAnchorGeometry } from "./connector-endpoints";
import { listCommentThreads, type CommentOrigin } from "./local-comments";

const COMMENT_ID_PREFIX = "miro-comment:";

/** Distinct from graph IDs, including when an imported comment has a node ID. */
export function commentSelectionId(origin: CommentOrigin, id: string): string {
  return `${COMMENT_ID_PREFIX}${origin}:${id}`;
}

export function selectedComment(id: string): { origin: CommentOrigin; id: string; key: string } | undefined {
  if (!id.startsWith(COMMENT_ID_PREFIX)) return undefined;
  const rest = id.slice(COMMENT_ID_PREFIX.length);
  const separator = rest.indexOf(":");
  const origin = rest.slice(0, separator);
  const threadId = rest.slice(separator + 1);
  return separator > 0 && threadId && (origin === "local" || origin === "imported")
    ? { origin, id: threadId, key: `${origin}:${threadId}` } : undefined;
}

/** A connector belongs to a rectangular selection only if its whole painted route does. */
export function routeContainedInBox(points: readonly AnchorPoint[], a: AnchorPoint, b: AnchorPoint): boolean {
  if(points.length<2)return false;
  const left=Math.min(a.x,b.x),right=Math.max(a.x,b.x),top=Math.min(a.y,b.y),bottom=Math.max(a.y,b.y);
  return points.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>=left&&p.x<=right&&p.y>=top&&p.y<=bottom);
}

export interface SelectedRouteEnds { readonly from:boolean; readonly to:boolean; readonly wholeRoute:boolean }

/** A marquee selects endpoint handles, not the unlimited span of a crossing line. */
export function routeEndsInBox(points:readonly AnchorPoint[],a:AnchorPoint,b:AnchorPoint):SelectedRouteEnds|undefined {
  if(points.length<2)return undefined;
  const from=pointInSelectionBox(points[0]!,a,b),to=pointInSelectionBox(points[points.length-1]!,a,b);
  return from||to?{from,to,wholeRoute:routeContainedInBox(points,a,b)}:undefined;
}

export function pointInSelectionBox(point:AnchorPoint,a:AnchorPoint,b:AnchorPoint):boolean {
  return Number.isFinite(point.x)&&Number.isFinite(point.y)
    &&point.x>=Math.min(a.x,b.x)&&point.x<=Math.max(a.x,b.x)
    &&point.y>=Math.min(a.y,b.y)&&point.y<=Math.max(a.y,b.y);
}

/** Selection is measured against the painted screen box, not a model centre. */
export function rectIntersectsBox(rect: {left:number;top:number;right:number;bottom:number}, a: AnchorPoint, b: AnchorPoint, contained=false): boolean {
  const left=Math.min(a.x,b.x),right=Math.max(a.x,b.x),top=Math.min(a.y,b.y),bottom=Math.max(a.y,b.y);
  if(![rect.left,rect.top,rect.right,rect.bottom].every(Number.isFinite))return false;
  return contained
    ? rect.left>=left&&rect.right<=right&&rect.top>=top&&rect.bottom<=bottom
    : rect.left<=right&&rect.right>=left&&rect.top<=bottom&&rect.bottom>=top;
}

/** Detached preview and commit share the same geometry; source records stay untouched. */
export function translateBoardSelection(document: Record<string, unknown>, ids: readonly string[], dx: number, dy: number,
  routeEnds:Readonly<Record<string,SelectedRouteEnds>>={}): Record<string, unknown> {
  const next=JSON.parse(JSON.stringify(document)) as Record<string, any>;
  const selected=new Set(ids);
  const geometry=Object.keys(routeEnds).length?buildCanvasAnchorGeometry(document):undefined;
  const follows=(anchor:unknown,fallback?:string):boolean=>{
    const normalized=normalizeAnchor(anchor).anchor;
    if(normalized?.type==="node"||normalized?.type==="image")return selected.has(normalized.nodeId);
    if(normalized?.type==="comment")return selected.has(commentSelectionId(normalized.origin,normalized.commentId));
    if(normalized?.type==="edge")return selected.has(normalized.edgeId);
    return anchor===undefined&&fallback!==undefined&&selected.has(fallback);
  };
  const comments=ids.map(selectedComment).filter((item): item is NonNullable<typeof item> => item !== undefined);
  if(comments.length){
    const geometry=buildCanvasAnchorGeometry(document);
    const threads=new Map(listCommentThreads(document).map(thread=>[`${thread.origin}:${thread.id}`,thread]));
    next.miroCanvas ??= {};
    next.miroCanvas.commentPlaces ??= {};
    for(const comment of comments){
      const point=geometry.comments?.[comment.key],thread=threads.get(comment.key);
      if(!point||!thread)continue;
      const place=next.miroCanvas.commentPlaces[comment.key];
      const anchor=normalizeAnchor(place??thread.anchor).anchor;
      // A selected parent carries its child comment already. Keep that link.
      if(anchor?.type==="node" && selected.has(anchor.nodeId)
        || anchor?.type==="image" && selected.has(anchor.nodeId)
        || anchor?.type==="comment" && selected.has(commentSelectionId(anchor.origin,anchor.commentId)))continue;
      next.miroCanvas.commentPlaces[comment.key]={type:"free",x:point.x+dx,y:point.y+dy};
    }
  }
  for(const node of next.nodes ?? []) if(selected.has(node.id)){node.x+=dx;node.y+=dy;}
  const connectors=boardConnectors(next);
  for(const c of connectors) if(selected.has(c.id)) {
    const mask=routeEnds[c.id];
    if(!mask){next.miroCanvas.connectors[c.id]=translateConnector(c,dx,dy);continue;}
    const route=geometry?.edges?.[c.id];
    const shifted={...c} as Record<string,unknown>;
    for(const end of ["from","to"] as const)if(mask[end]){
      const anchor=c[end],point=end==="from"?route?.start:route?.end;
      if(anchor.type==="free")shifted[end]={...anchor,x:anchor.x+dx,y:anchor.y+dy};
      else if(!follows(anchor)&&point)shifted[end]={type:"free",x:point.x+dx,y:point.y+dy};
    }
    if(mask.wholeRoute&&c.waypoints)shifted.waypoints=c.waypoints.map(p=>({x:p.x+dx,y:p.y+dy}));
    next.miroCanvas.connectors[c.id]=shifted;
  }
  // Native route control points are absolute board coordinates as well.
  for(const edge of next.edges ?? []) if(selected.has(edge.id)||selected.has(edge.fromNode)&&selected.has(edge.toNode)) {
    const mask=routeEnds[edge.id];
    if(mask){
      const override=next.miroCanvas?.localOverrides?.[edge.id];
      const anchors=override?.connectorAnchors;
      const route=geometry?.edges?.[edge.id];
      const replacements:Record<string,unknown>={};
      for(const end of ["from","to"] as const)if(mask[end]){
        const point=end==="from"?route?.start:route?.end;
        if(!follows(anchors?.[end],edge[`${end}Node`])&&point)
          replacements[end]={type:"free",x:point.x+dx,y:point.y+dy};
      }
      if(Object.keys(replacements).length){
        next.miroCanvas ??={schemaVersion:1};next.miroCanvas.localOverrides ??={};
        const target=next.miroCanvas.localOverrides[edge.id]??={};
        target.connectorAnchors={...target.connectorAnchors,...replacements};
      }
      if(mask.wholeRoute&&override?.connector?.waypoints)
        override.connector.waypoints=override.connector.waypoints.map((p:{x:number;y:number})=>({x:p.x+dx,y:p.y+dy}));
      continue;
    }
    const override=next.miroCanvas?.localOverrides?.[edge.id];
    if(override?.connector?.waypoints) override.connector.waypoints=override.connector.waypoints.map((p:{x:number;y:number})=>({x:p.x+dx,y:p.y+dy}));
    for(const end of ["from","to"]) {
      const anchor=override?.connectorAnchors?.[end];
      if(anchor?.type==="free"){anchor.x+=dx;anchor.y+=dy;}
    }
  }
  return next;
}
