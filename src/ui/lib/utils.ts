/**
 * Class-name merge helper. Borrowed from shadcn/ui (https://ui.shadcn.com/docs/installation/manual).
 */

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
