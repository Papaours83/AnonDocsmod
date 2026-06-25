import { Request, Response, NextFunction } from 'express';
import multer from 'multer';

export function errorHandler(
  error: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  console.error('Error:', error);

  // Multer-specific errors → user-friendly 400 instead of opaque 500
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      res.status(400).json({
        error: 'File too large',
        message: 'Le fichier dépasse la taille maximale autorisée (50 MB).',
      });
      return;
    }
    res.status(400).json({
      error: 'Upload error',
      message: error.message,
    });
    return;
  }

  // Custom file-filter errors (e.g. unsupported mime type) come through as
  // plain Error instances rejected by multer's fileFilter callback.
  if (error.message?.includes('files are allowed')) {
    res.status(400).json({ error: 'Unsupported file type', message: error.message });
    return;
  }

  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'An error occurred',
  });
}
