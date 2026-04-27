declare module "epubjs" {
  const ePub: (url: string | ArrayBuffer | Blob) => unknown;
  export default ePub;
}
