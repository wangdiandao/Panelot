import { useRef, type ReactNode } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';

interface FilePickerButtonProps {
  id: string;
  label: string;
  accept?: string;
  disabled?: boolean;
  children?: ReactNode;
  onFile: (file: File) => void;
}

export function FilePickerButton({
  id,
  label,
  accept,
  disabled = false,
  children,
  onFile,
}: FilePickerButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <Label htmlFor={id} className="sr-only">
        {label}
      </Label>
      <Input
        ref={inputRef}
        id={id}
        type="file"
        accept={accept}
        disabled={disabled}
        tabIndex={-1}
        className="sr-only"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) onFile(file);
          event.currentTarget.value = '';
        }}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        aria-controls={id}
        onClick={() => inputRef.current?.click()}
      >
        {children ?? label}
      </Button>
    </>
  );
}
