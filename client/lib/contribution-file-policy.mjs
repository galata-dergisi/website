// Copyright 2026 Mehmet Baker

const ACCEPTED_FILE_TYPES = Object.freeze({
  document: [
    'text/plain, application/pdf, application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.oasis.opendocument.text, application/rtf',
    '.txt, .pdf, .doc, .docx, .odt, .rtf',
  ].join(', '),
  image: 'image/*, .png, .jpg, .jpeg, .bmp, .tiff, .tif',
  audio: 'audio/*, .mp3, .ogg',
});

const FILE_EXTENSIONS = Object.freeze({
  document: new Set(['.txt', '.pdf', '.doc', '.docx', '.odt', '.rtf']),
  image: new Set(['.png', '.jpg', '.jpeg', '.bmp', '.tiff', '.tif']),
  audio: new Set(['.mp3', '.ogg']),
});

const ASSET_FILE_KINDS = Object.freeze({
  siir: 'document',
  oyku: 'document',
  deneme: 'document',
  roportaj: 'document',
  elestiri: 'document',
  resim: 'image',
  ses: 'audio',
});

export function acceptedFileTypes(assetType) {
  return ACCEPTED_FILE_TYPES[ASSET_FILE_KINDS[assetType]] || '';
}

export function fileMatchesAssetType(file, assetType) {
  const allowedExtensions = FILE_EXTENSIONS[ASSET_FILE_KINDS[assetType]];
  if (!file || !allowedExtensions) return false;

  const filename = String(file.name || '').toLocaleLowerCase('en-US');
  const extensionStart = filename.lastIndexOf('.');
  if (extensionStart < 0) return false;
  return allowedExtensions.has(filename.slice(extensionStart));
}
