import {getRuntime} from '../model-builder/manifold-runtime.mjs'
import {createBaseHeightGuideHandler} from '../model-builder/base-height-guide-job.mjs'
self.onmessage=createBaseHeightGuideHandler(getRuntime,(data,transfer)=>self.postMessage(data,transfer))
