import { X } from 'lucide-react'
import type { TaskImage } from '@/lib/types'
import { taskImageUrl } from '@/lib/taskImageUpload'

// A clipboard-pasted reference image: a thumbnail that opens the full image in
// a new tab. When `onRemove` is given, an X button (revealed on hovering the
// thumbnail itself) detaches it. Shared by the project panel and run cockpit.
export const TaskImageThumb = ({
  image,
  projectPath,
  onRemove,
  size = 48,
}: {
  image: TaskImage
  projectPath: string
  onRemove?: () => void
  /** Thumbnail edge length in px — smaller in dense lists. */
  size?: number
}) => {
  const url = taskImageUrl(projectPath, image.id)
  return (
    <div
      className="group/thumb relative"
      style={{ width: size, height: size }}
    >
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        title={`${image.name} — open full size`}
        className="block h-full w-full overflow-hidden rounded-[2px] border border-line transition-colors hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1"
      >
        <img src={url} alt={image.name} className="h-full w-full object-cover" />
      </a>
      {onRemove && (
        <button
          onClick={onRemove}
          title="Remove image"
          className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-[2px] bg-bg-card/85 text-ink-muted opacity-0 transition-colors hover:bg-accent hover:text-bg-card focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent group-hover/thumb:opacity-100"
        >
          <X size={10} strokeWidth={2.5} />
        </button>
      )}
    </div>
  )
}
