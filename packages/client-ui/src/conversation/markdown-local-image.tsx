import { useEffect, useState, type ImgHTMLAttributes, type JSX } from "react";

interface MarkdownLocalImageProps extends ImgHTMLAttributes<HTMLImageElement> {
  href: string;
  resolveSource: (href: string) => Promise<string>;
}

export const MarkdownLocalImage = ({
  href,
  resolveSource,
  alt,
  ...props
}: MarkdownLocalImageProps): JSX.Element => {
  const [image, setImage] = useState<{
    href: string;
    source?: string;
    error?: string;
  } | null>(null);

  useEffect(() => {
    let active = true;
    void resolveSource(href).then(
      (source) => {
        if (active) setImage({ href, source });
      },
      (error: unknown) => {
        if (active) {
          setImage({
            href,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    );
    return () => {
      active = false;
    };
  }, [href, resolveSource]);

  if (image?.href === href && image.source) {
    return <img {...props} src={image.source} alt={alt ?? ""} />;
  }
  return (
    <span
      role="img"
      aria-label={alt || href}
      title={image?.href === href ? image.error : undefined}
    >
      {alt}
    </span>
  );
};
