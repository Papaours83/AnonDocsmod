import multer from 'multer';
import path from 'path';
import fs from 'fs';

const uploadDir = './uploads';

// Create uploads directory if it doesn't exist
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadDir);
  },
  filename: (_req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});

const allowedMimeTypes = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
];

// Browsers/OSes (Windows especially) frequently send docx or txt with a
// generic or wrong MIME type — application/octet-stream, application/msword,
// text/rtf, etc. Relying on the MIME type alone rejects legitimate files, so
// we also accept based on the file extension.
const allowedExtensions = ['.pdf', '.docx', '.txt'];

const fileFilter = (_req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const ext = path.extname(file.originalname).toLowerCase();
  const mimeOk = allowedMimeTypes.includes(file.mimetype);
  const extOk = allowedExtensions.includes(ext);

  if (mimeOk || extOk) {
    cb(null, true);
  } else if (ext === '.doc' || file.mimetype === 'application/msword') {
    // Legacy binary Word (.doc) is not supported (mammoth reads .docx only).
    // Give a targeted, actionable message instead of the generic one.
    cb(
      new Error(
        'Les fichiers .doc (Word 97-2003) ne sont pas pris en charge. ' +
          'Enregistrez le document en .docx (Fichier > Enregistrer sous > Word .docx), puis réessayez.'
      )
    );
  } else {
    cb(new Error('Only PDF, DOCX, and TXT files are allowed'));
  }
};

export const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB
  },
});
