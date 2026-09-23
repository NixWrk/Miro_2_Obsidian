import {describe,it,expect} from "vitest";
import {commentSelectionId, pointInSelectionBox, rectIntersectsBox, routeContainedInBox, routeEndsInBox, selectedComment, translateBoardSelection} from "../src/board-selection";
describe("connector marquee hit testing",()=>{
  const a={x:10,y:10},b={x:20,y:20};
  it("does not select a long connector just because it crosses the box",()=>{
    expect(routeContainedInBox([{x:0,y:15},{x:30,y:15}],a,b)).toBe(false);
    expect(routeContainedInBox([{x:15,y:0},{x:15,y:30}],b,a)).toBe(false);
  });
  it("selects a whole route in either drag direction",()=>{
    const route=[{x:10,y:15},{x:15,y:18},{x:20,y:15}];
    expect(routeContainedInBox(route,a,b)).toBe(true);
    expect(routeContainedInBox(route,b,a)).toBe(true);
  });
  it("rejects a curved route that bows outside and invalid routes",()=>{
    expect(routeContainedInBox([{x:11,y:15},{x:15,y:25},{x:19,y:15}],a,b)).toBe(false);
    expect(routeContainedInBox([{x:15,y:15},{x:15,y:15}],a,b)).toBe(true);
    expect(routeContainedInBox([{x:15,y:15},{x:NaN,y:15}],a,b)).toBe(false);
    expect(routeContainedInBox([],a,b)).toBe(false);
  });
  it("records only the endpoint caught by a small marquee",()=>{
    expect(routeEndsInBox([{x:15,y:15},{x:30,y:15}],a,b)).toEqual({from:true,to:false,wholeRoute:false});
    expect(routeEndsInBox([{x:0,y:15},{x:30,y:15}],a,b)).toBeUndefined();
  });
});

describe("endpoint-aware group movement",()=>{
  const document=()=>({nodes:[],edges:[],miroCanvas:{schemaVersion:1,connectors:{
    long:{id:"long",from:{type:"free",x:15,y:15},to:{type:"free",x:300,y:15},route:"straight",color:"#123456",width:2,startCap:"none",endCap:"arrow"}
  }}});
  it("moves the captured free end, never the far end",()=>{
    const before=document();
    const after=translateBoardSelection(before,["long"],20,10,{long:{from:true,to:false,wholeRoute:false}}) as any;
    expect(after.miroCanvas.connectors.long.from).toMatchObject({x:35,y:25});
    expect(after.miroCanvas.connectors.long.to).toMatchObject({x:300,y:15});
    expect(before.miroCanvas.connectors.long.from.x).toBe(15);
  });
  it("keeps an attached selected end attached to a node moved in the same group",()=>{
    const before=document() as any;
    before.nodes=[{id:"n",type:"text",x:0,y:0,width:30,height:30}];
    before.miroCanvas.connectors.long.from={type:"node",nodeId:"n",u:1,v:0.5};
    const after=translateBoardSelection(before,["n","long"],20,10,{long:{from:true,to:false,wholeRoute:false}}) as any;
    expect(after.nodes[0]).toMatchObject({x:20,y:10});
    expect(after.miroCanvas.connectors.long.from).toEqual(before.miroCanvas.connectors.long.from);
    expect(after.miroCanvas.connectors.long.to).toMatchObject({x:300,y:15});
  });
  it("moves just the selected native edge end through a free-anchor override",()=>{
    const before={nodes:[
      {id:"a",type:"text",x:0,y:0,width:30,height:30},
      {id:"b",type:"text",x:300,y:0,width:30,height:30}],
      edges:[{id:"e",fromNode:"a",toNode:"b"}],miroCanvas:{schemaVersion:1,localOverrides:{}}};
    const after=translateBoardSelection(before,["e"],20,10,{e:{from:true,to:false,wholeRoute:false}}) as any;
    expect(after.miroCanvas.localOverrides.e.connectorAnchors.from).toMatchObject({type:"free",x:35,y:25});
    expect(after.miroCanvas.localOverrides.e.connectorAnchors.to).toBeUndefined();
    expect(after.nodes).toEqual(before.nodes);
  });
  it("keeps a native end attached when its node is inside the same selection",()=>{
    const before={nodes:[
      {id:"a",type:"text",x:0,y:0,width:30,height:30},
      {id:"b",type:"text",x:300,y:0,width:30,height:30}],
      edges:[{id:"e",fromNode:"a",toNode:"b"}],miroCanvas:{schemaVersion:1,localOverrides:{}}};
    const after=translateBoardSelection(before,["a","e"],20,10,{e:{from:true,to:false,wholeRoute:false}}) as any;
    expect(after.nodes[0]).toMatchObject({x:20,y:10});
    expect(after.nodes[1]).toEqual(before.nodes[1]);
    expect(after.miroCanvas.localOverrides.e).toBeUndefined();
  });
});

describe("painted rectangle hit testing",()=>{
  const rect={left:100,top:100,right:140,bottom:140};
  it("uses the node or pin center, not any overlapping corner",()=>{
    const center={x:120,y:120};
    expect(pointInSelectionBox(center,{x:110,y:110},{x:150,y:150})).toBe(true);
    expect(pointInSelectionBox(center,{x:150,y:150},{x:110,y:110})).toBe(true);
    expect(pointInSelectionBox(center,{x:130,y:130},{x:180,y:180})).toBe(false);
  });
  it("requires full containment for frame groups",()=>{
    expect(rectIntersectsBox(rect,{x:110,y:110},{x:150,y:150},true)).toBe(false);
    expect(rectIntersectsBox(rect,{x:90,y:90},{x:150,y:150},true)).toBe(true);
  });
  it("rejects invalid painted bounds",()=>{
    expect(rectIntersectsBox({...rect,left:NaN},{x:90,y:90},{x:150,y:150})).toBe(false);
  });
});

describe("comment-inclusive selection movement",()=>{
  const document=()=>({nodes:[{id:"n",type:"text",x:0,y:0,width:100,height:100}],edges:[],miroCanvas:{
    schemaVersion:1,localComments:[
      {id:"free",text:"Free",anchor:{type:"free",x:200,y:50},replies:[]},
      {id:"attached",text:"Attached",anchor:{type:"node",nodeId:"n",u:0.5,v:0.5},replies:[]}
    ],commentPlaces:{}}});
  it("moves a free comment and node in one detached preview",()=>{
    const before=document();const id=commentSelectionId("local","free");
    expect(selectedComment(id)).toEqual({origin:"local",id:"free",key:"local:free"});
    const after=translateBoardSelection(before,["n",id],30,20) as any;
    expect(after.nodes[0]).toMatchObject({x:30,y:20});
    expect(after.miroCanvas.commentPlaces["local:free"]).toEqual({type:"free",x:230,y:70});
    expect(before.nodes[0].x).toBe(0);expect(before.miroCanvas.commentPlaces).toEqual({});
  });
  it("retains a selected comment's attachment when its parent moves too",()=>{
    const before=document(),id=commentSelectionId("local","attached");
    const together=translateBoardSelection(before,["n",id],30,20) as any;
    expect(together.miroCanvas.commentPlaces["local:attached"]).toBeUndefined();
    const alone=translateBoardSelection(before,[id],30,20) as any;
    expect(alone.miroCanvas.commentPlaces["local:attached"]).toEqual({type:"free",x:80,y:70});
  });
});
