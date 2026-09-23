import { describe, expect, it } from "vitest";
import { boardConnectors, connectorEndCap, connectorRoutes, migrateLineNodes, nearestRouteFraction, readBoardConnector, reshapeBoardConnector, restyleBoardConnector, translateConnector, type BoardConnector } from "../src/board-connectors";
import { pointOnPolyline } from "../src/anchors";
import { routeHandles } from "../src/connector-route";
import { buildCanvasAnchorGeometry, updateConnectorEndpoint } from "../src/connector-endpoints";
import { validateMiroCanvasMetadata } from "../src/metadata";
const line: BoardConnector = {id:"a",from:{type:"free",x:10,y:20},to:{type:"free",x:110,y:20},route:"straight",color:"#123456",width:2,startCap:"none",endCap:"arrow"};
const legacy = () => ({nodes:[{id:"old",type:"text",text:"",x:10,y:20,width:100,height:50}],edges:[],miroSource:{future:[1]},miroCanvas:{schemaVersion:1,localOverrides:{old:{future:"kept",localItem:{type:"line",line:{route:"straight",color:"#123456",width:2,box:{width:100,height:50},points:[0,0,100,50]}}}}}});
describe("independent board connectors",()=>{
  it("stores a bounded label and projects its movable route fraction",()=>{
    const c={...line,label:"Next step",labelT:0.75};
    expect(readBoardConnector(c)).toEqual(c);
    expect(readBoardConnector({...c,labelT:1.1})).toBeUndefined();
    expect(readBoardConnector({...c,label:"x".repeat(1025)})).toBeUndefined();
    expect(pointOnPolyline([{x:0,y:0},{x:100,y:0},{x:100,y:100}],0.75)).toEqual({x:100,y:50});
    expect(nearestRouteFraction([{x:0,y:0},{x:100,y:0},{x:100,y:100}],{x:110,y:50})).toBe(0.75);
    expect(translateConnector(c,20,30)).toMatchObject({label:"Next step",labelT:0.75});
  });
  it("validates optional head sizes and preserves them through movement and restyling",()=>{
    for (const headSize of [1, 12.5, 1000]) {
      const c = {...line, headSize};
      expect(readBoardConnector(c)).toEqual(c);
      expect(translateConnector(c, 10, 20).headSize).toBe(headSize);
      expect(restyleBoardConnector(c, {width: 50}).headSize).toBe(headSize);
    }
    for (const headSize of [0, -1, 1001, NaN, Infinity, "20", null]) {
      expect(readBoardConnector({...line, headSize})).toBeUndefined();
    }
    expect(readBoardConnector(line)?.headSize).toBeUndefined();
  });
  for (const kind of ["straight", "curved", "elbowed"] as const) it(`reshapes a ${kind} body while preserving endpoint anchors`,()=>{
    const c:BoardConnector={...line,route:kind,from:{type:"node",nodeId:"n",u:1,v:0.5},to:{type:"free",x:300,y:150}};
    const geometry={nodes:{n:{x:0,y:0,width:100,height:100}}};
    const route=connectorRoutes([c],geometry).get(c.id)!;
    const grip=routeHandles(route)[0]!;
    const next=reshapeBoardConnector(c,route,grip,{x:grip.point.x+40,y:grip.point.y+50});
    expect(next.from).toEqual(c.from);expect(next.to).toEqual(c.to);
    expect(connectorRoutes([next],geometry).get(c.id)!.path).not.toBe(route.path);
    expect(next.color).toBe(c.color);expect(next.width).toBe(c.width);
    expect(readBoardConnector(next)).toBeDefined();
  });
  it("allows legacy block arrows to reverse or become ordinary lines without losing anchors",()=>{
    const block:BoardConnector={...line,block:true,endCap:"none"};
    expect(connectorEndCap(block)).toBe("stealth");
    expect(restyleBoardConnector(block,{startCap:"stealth",endCap:"none"})).toMatchObject({block:true,startCap:"stealth",endCap:"none"});
    const plain=restyleBoardConnector(block,{endCap:"none"});
    expect(plain.block).toBeUndefined();expect(plain.from).toEqual(block.from);expect(plain.to).toEqual(block.to);
    expect(restyleBoardConnector(block,{route:"curved"}).block).toBeUndefined();
    expect(restyleBoardConnector(block,{width:30})).toMatchObject({block:true,endCap:"stealth",width:30});
    expect(block.endCap).toBe("none");
  });
  it("validates maps without treating arrows as another element type",()=>{
    expect(readBoardConnector(line)).toEqual(line);
    expect(validateMiroCanvasMetadata({schemaVersion:1,connectors:{a:line}}).valid).toBe(true);
    expect(validateMiroCanvasMetadata({schemaVersion:1,connectors:{wrong:line}}).valid).toBe(false);
    expect(readBoardConnector({...line,width:NaN})).toBeUndefined();
  });
  it("resolves connector chains and keeps independent styles",()=>{
    const b:BoardConnector={...line,id:"b",color:"#ff0000",from:{type:"edge",edgeId:"a",t:0.5},to:{type:"free",x:60,y:120},endCap:"none"};
    const before=JSON.stringify([line,b]);
    expect(connectorRoutes([b,line],{}).get("b")?.start).toMatchObject({x:60,y:20});
    expect(JSON.stringify([line,b])).toBe(before);
  });
  it("rejects cycles even when stale cached geometry contains their IDs",()=>{
    const a={...line,from:{type:"edge" as const,edgeId:"b",t:0.5}}, b={...line,id:"b",from:{type:"edge" as const,edgeId:"a",t:0.5}};
    expect(connectorRoutes([a,b],{edges:{a:{start:{x:0,y:0},end:{x:1,y:1}}}}).size).toBe(0);
  });
  it("moves free ends and waypoints without breaking attached ends",()=>{
    const c={...line,from:{type:"node" as const,nodeId:"n",u:1,v:0.5},waypoints:[{x:50,y:10}]};
    expect(translateConnector(c,40,30)).toMatchObject({from:c.from,to:{x:150,y:50},waypoints:[{x:90,y:40}]});
  });
  it("keeps moved connectors without waypoints valid for metadata writes",()=>{
    const moved=translateConnector(line,40,30);
    expect(Object.prototype.hasOwnProperty.call(moved,"waypoints")).toBe(false);
    expect(validateMiroCanvasMetadata({schemaVersion:1,connectors:{a:moved}}).valid).toBe(true);
  });
  it("migrates once, preserving evidence, unknown fields and the exact legacy archive",()=>{
    const input=legacy(), before=JSON.stringify(input), result=migrateLineNodes(input);
    expect(result.migrated).toEqual(["old"]);expect(result.document.nodes).toEqual([]);
    expect(boardConnectors(result.document)[0]).toMatchObject({from:{x:10,y:20},to:{x:110,y:70},endCap:"none"});
    expect(result.document.miroSource).toEqual(input.miroSource);
    expect((result.document.miroCanvas as any).connectorMigrationArchive.old.node).toEqual(input.nodes[0]);
    expect(migrateLineNodes(result.document).migrated).toEqual([]);
    expect(JSON.stringify(input)).toBe(before);
  });
  it("retains legacy nodes with native links instead of dropping links",()=>{
    const input=legacy() as any;input.edges=[{id:"e",fromNode:"old",toNode:"n"}];
    expect(migrateLineNodes(input).skipped).toEqual(["old"]);
    expect(migrateLineNodes(input).document).toEqual(input);
  });
  it("bakes straight-line rotation into board coordinates and archives the original",()=>{
    const input=legacy() as any;input.miroCanvas.localOverrides.old.rotation=90;
    const result=migrateLineNodes(input), c=boardConnectors(result.document)[0]!;
    expect(c.from.x).toBeCloseTo(85);expect(c.from.y).toBeCloseTo(-5);
    expect(c.to.x).toBeCloseTo(35);expect(c.to.y).toBeCloseTo(95);
    expect((result.document.miroCanvas as any).localOverrides.old.rotation).toBeUndefined();
    expect((result.document.miroCanvas as any).connectorMigrationArchive.old.override.rotation).toBe(90);
  });
  it("retains nodes targeted by independent anchors instead of orphaning them",()=>{
    const input=legacy() as any;
    input.miroCanvas.connectors={a:{...line,from:{type:"node",nodeId:"old",u:0,v:0.5}}};
    expect(migrateLineNodes(input).skipped).toEqual(["old"]);
    expect(migrateLineNodes(input).document).toEqual(input);
  });
  it("shares geometry with native edges and supports native-to-independent attachment",()=>{
    const doc={nodes:[{id:"n",type:"text",x:0,y:0,width:100,height:100},{id:"m",type:"text",x:300,y:0,width:100,height:100}],edges:[{id:"e",fromNode:"n",toNode:"m",fromSide:"right",toSide:"left"}],miroCanvas:{schemaVersion:1,connectors:{a:line}}};
    expect(buildCanvasAnchorGeometry(doc).edges?.a?.start).toMatchObject({x:10,y:20});
    const result=updateConnectorEndpoint(doc,{edgeId:"e",end:"to",anchor:{type:"edge",edgeId:"a",t:0.5}});
    expect(result.ok).toBe(true);
  });
});
