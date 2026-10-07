declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string | null;
        name: string;
        role: string;
        status: string;
      };
    }
  }
}

export {};
