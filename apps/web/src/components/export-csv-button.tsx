import { useMutation } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { saveFile } from '@/lib/download';

/**
 * Downloads a report as CSV (RPT-04). `exportFile` calls the typed client with the
 * report's current filters, so the file matches what is on screen.
 */
export function ExportCsvButton({
  label,
  fallbackName,
  exportFile,
}: {
  label: string;
  fallbackName: string;
  exportFile: () => Promise<Blob>;
}) {
  const download = useMutation({
    mutationFn: exportFile,
    onSuccess: (file) => saveFile(file, fallbackName),
  });

  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={download.isPending}
        onClick={() => download.mutate()}
      >
        {label}
      </Button>
      {download.isError && (
        <p role="alert" className="text-sm text-destructive">
          ส่งออก CSV ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง
        </p>
      )}
    </div>
  );
}
