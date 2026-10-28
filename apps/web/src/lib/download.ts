/** Save a file the API returned (a CSV export) through the browser's download. */
export function saveFile(file: Blob, fallbackName: string): void {
  const name = file instanceof File && file.name ? file.name : fallbackName;
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
