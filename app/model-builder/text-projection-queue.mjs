// Share the release validation with its matching preview. A late wrap may
// never overwrite or commit a newer requested position.
export function createTextProjectionQueue(launch,publish){
 let serial=0,busy=false,latest=null,closed=false
 return {
  request(point,complete){
   if(closed)return
   const key=JSON.stringify(point)
   if(latest?.key===key){
    if(complete){if(latest.result)complete(latest.result);else latest.complete=complete}
    return
   }
   latest={id:++serial,key,point,complete}
   if(!busy){busy=true;launch({id:latest.id,point})}
  },
  receive(data){
   if(closed||!latest)return
   if(data.id!==latest.id){launch({id:latest.id,point:latest.point});return}
   busy=false;latest.result=data;publish(data,latest.point);latest.complete?.(data)
  },
  close(){closed=true;latest=null},
 }
}
