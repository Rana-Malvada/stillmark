/** Server-created temporary video; never accepts paths from request metadata. */
export interface DiskVideo {
  path: string
  length: number
  hash: string
  read(offset: number, length: number): Promise<Buffer>
}
