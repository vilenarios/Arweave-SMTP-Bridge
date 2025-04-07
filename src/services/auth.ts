// src/utils/auth.ts
export function isAllowedEmail(email: string): boolean {
    const lowerEmail = email.toLowerCase();
    const domain = lowerEmail.split('@')[1];
  
    const allowList = (process.env.FORWARD_ALLOWED_EMAILS || '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
  
    for (const allowed of allowList) {
      if (allowed === lowerEmail) return true;
      if (allowed.startsWith('*@')) {
        const allowedDomain = allowed.slice(2);
        if (domain === allowedDomain) return true;
      }
    }
  
    return false;
}
  