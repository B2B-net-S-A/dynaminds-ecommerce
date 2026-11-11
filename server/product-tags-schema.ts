import { z } from 'zod';
export const productTags = z.array(z.string().trim().min(1).max(80)
  .refine(v=>!/[\x00-\x1f\x7f]/.test(v)&&v===v.normalize('NFC'),'Tag wymaga poprawnego NFC bez znaków sterujących'))
  .max(20).refine(v=>new Set(v).size===v.length,'Powtórzony tag')
  .transform(v=>[...v].sort((a,b)=>{const x=Array.from(a),y=Array.from(b);for(let i=0;i<Math.min(x.length,y.length);i++){const d=x[i].codePointAt(0)!-y[i].codePointAt(0)!;if(d)return d;}return x.length-y.length;}));
