declare module 'hyperswarm' {
  import { EventEmitter } from 'events'
  export default class Hyperswarm extends EventEmitter {
    constructor(opts?: object)
    join(topic: Buffer, opts?: { server?: boolean; client?: boolean }): { flushed(): Promise<void> }
    leave(topic: Buffer): Promise<void>
    destroy(): Promise<void>
    flush(): Promise<void>
  }
}

declare module 'z32' {
  const z32: {
    encode(buf: Uint8Array): string
    decode(s: string): Uint8Array
  }
  export default z32
}

declare module 'b4a' {
  const b4a: {
    toString(buf: Uint8Array, encoding?: string): string
    from(input: string | Uint8Array, encoding?: string): Buffer
    equals(a: Uint8Array, b: Uint8Array): boolean
  }
  export default b4a
}
