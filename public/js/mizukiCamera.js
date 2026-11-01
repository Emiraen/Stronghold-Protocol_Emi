// Original CameraController keeps the camera prefab rotation and adds the
// aspect-adaptation parent offset in source world axes. Focus is not look-at.
export function mizukiCameraProjection(library, stage, viewport) {
  if (!stage || stage.id.endsWith(':mizuki-prep')) return null;
  if (!library?.camera) throw Error('Original Mizuki camera library unavailable');
  const scene=library.scenes[library.stages[stage.id]];
  if (!scene) throw Error('Original Mizuki camera unavailable: '+stage.id);
  const camera=library.camera, matrix=scene.boardFromSourceWorld;
  const width=Math.max(1,viewport.width),height=Math.max(1,viewport.height);
  const a=camera.aspectAdaptation,from=a._fromResolution,to=a._toResolution;
  const t=Math.max(0,Math.min(1,(height/width-from.y/from.x)/(to.y/to.x-from.y/from.x)));
  const offset=['x','y','z'].map(key=>a._fromLocalPosition[key]+t*(a._toLocalPosition[key]-a._fromLocalPosition[key]));
  const linear=vector=>matrix.slice(0,3).map(row=>row.slice(0,3).reduce((sum,n,i)=>sum+n*vector[i],0));
  const delta=linear(offset),position=scene.boardPosition.map((v,i)=>v+delta[i]);
  const forward=linear(camera.sourceForward),up=linear(camera.sourceUp);
  if(Math.abs(forward[0])>1e-5||Math.abs(up[0])>1e-5)throw Error('Original camera has unsupported yaw: '+stage.id);
  const tilt=Math.atan2(forward[1],-forward[2]),dist=position[2]/Math.cos(tilt);
  const focal=height/(2*Math.tan(camera.verticalFov*Math.PI/360));
  return { params:{tx:position[0],ty:position[1]+dist*Math.sin(tilt),tz:0,tilt:tilt*180/Math.PI,dist,scale:focal/dist,cx:width/2,cy:height/2},
    clip:{near:camera.near,far:camera.far},source:{scene:library.stages[stage.id],position,forward,up,verticalFov:camera.verticalFov,aspectRatio:t} };
}
