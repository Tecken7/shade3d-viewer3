export function ctIsoLevel(densityMin=350,densityMax=2200) {
  const low=Math.max(0,Math.min(.998,(densityMin+1024)/4095))
  const high=Math.max(low+.002,Math.min(1,(Math.max(densityMin+10,densityMax)+1024)/4095))
  return (low+(high-low)*.16)*255
}

