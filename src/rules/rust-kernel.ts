/** Shared Node/browser Wasm ABI; all rule work happens in the Rust module. */
export interface RustMeta {
  schema: 'tavern-rust-kernel-v1'; abi: number; patch: string; fullEngineReady: boolean;
  catalogSha256: string; commands: string[]; pending: string[];
}
type Exports = {
  memory: WebAssembly.Memory;
  tavern_abi_version: () => number;
  tavern_alloc: (size: number) => number;
  tavern_free: (ptr: number, size: number) => void;
  tavern_request: (ptr: number, size: number) => number;
};
const MAX_BYTES=32*1024*1024;
export class RustKernel {
  private wasm: Exports;
  readonly meta: RustMeta;
  constructor(bytes: BufferSource) {
    this.wasm=new WebAssembly.Instance(new WebAssembly.Module(bytes),{}).exports as unknown as Exports;
    if(this.wasm.tavern_abi_version()!==1) throw Error('Unsupported Rust rules ABI');
    this.meta=this.call<RustMeta>({command:'meta'});
    if(this.meta.abi!==1||this.meta.schema!=='tavern-rust-kernel-v1')throw Error('Incompatible Rust rules metadata');
  }
  requireFullEngine() {
    if(!this.meta.fullEngineReady)throw Error('Rust 完整规则尚未通过迁移验收：'+this.meta.pending.join('、'));
  }
  call<T>(request: Record<string, unknown>): T {
    const input=new TextEncoder().encode(JSON.stringify(request));
    if(!input.length||input.length>MAX_BYTES)throw Error('Rust request exceeds 32 MiB');
    const ptr=this.wasm.tavern_alloc(input.length);
    if(!ptr)throw Error('Rust input allocation failed');
    let response=0,size=0;
    try {
      new Uint8Array(this.wasm.memory.buffer,ptr,input.length).set(input);
      response=this.wasm.tavern_request(ptr,input.length);
      if(!response)throw Error('Rust response allocation failed');
      // The call may grow Wasm memory, invalidating all earlier views.
      size=new DataView(this.wasm.memory.buffer).getUint32(response,true);
      if(size>MAX_BYTES-4||response+4+size>this.wasm.memory.buffer.byteLength)throw Error('Invalid Rust response buffer');
      const text=new TextDecoder('utf-8',{fatal:true}).decode(new Uint8Array(this.wasm.memory.buffer,response+4,size));
      const result=JSON.parse(text) as {ok:boolean;result:T;error?:string};
      if(!result.ok)throw Error(result.error||'Rust rule operation failed');
      return result.result;
    }finally{
      if(response&&size<=MAX_BYTES-4)this.wasm.tavern_free(response,size+4);
      this.wasm.tavern_free(ptr,input.length);
    }
  }
}
