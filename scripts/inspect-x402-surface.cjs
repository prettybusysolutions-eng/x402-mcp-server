'use strict';
// Read-only installed-package surface inspection; no network, wallets, or payments.
const fs=require('node:fs');
const path=require('node:path');
const express=require('@x402/express');
const {x402ResourceServer}=express;
const root=path.dirname(require.resolve('@x402/express'));
let packageVersion='unknown';
let cursor=root;
for(let i=0;i<6;i++){
 const file=path.join(cursor,'package.json');
 if(fs.existsSync(file)){
  const p=JSON.parse(fs.readFileSync(file,'utf8'));
  if(p.name==='@x402/express'){packageVersion=p.version;break;}
 }
 cursor=path.dirname(cursor);
}
const surface={
 packageVersion,
 expressExports:Object.keys(express).sort(),
 resourceServerPrototypeMethods:typeof x402ResourceServer==='function'
  ?Object.getOwnPropertyNames(x402ResourceServer.prototype).sort():[],
 paymentMiddlewareType:typeof express.paymentMiddleware,
};
console.log(JSON.stringify(surface,null,2));
// Do not assert settlement hook existence from a name alone. Source/behavior review required.
if(surface.paymentMiddlewareType!=='function') process.exitCode=1;
