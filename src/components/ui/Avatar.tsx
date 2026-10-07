import { resolveMediaUrl } from '../../lib/api'

type AvatarProps = {
  src: string
  alt: string
  size?: 'sm' | 'md' | 'lg' | 'xl'
  status?: 'online' | 'offline'
}

const sizeMap = {
  sm: 'h-9 w-9',
  md: 'h-11 w-11',
  lg: 'h-14 w-14',
  xl: 'h-20 w-20',
}

export function Avatar({ src, alt, size = 'md', status }: AvatarProps) {
  const source = resolveMediaUrl(src)
  const initials = alt.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || '?'
  return (
    <div className={`relative inline-flex overflow-hidden rounded-full ring-2 ring-white shadow-sm ${sizeMap[size]}`}>
      {source
        ? <img src={source} crossOrigin={src.startsWith('/api/media/') ? 'use-credentials' : undefined} alt={alt} className="h-full w-full object-cover" />
        : <span role="img" aria-label={alt} className="flex h-full w-full items-center justify-center bg-gradient-to-br from-blue-600 to-violet-600 text-sm font-bold text-white">{initials}</span>}
      {status ? (
        <span
          className={`absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-white ${
            status === 'online' ? 'bg-emerald-500' : 'bg-slate-300'
          }`}
          aria-label={status === 'online' ? 'Online' : 'Offline'}
        />
      ) : null}
    </div>
  )
}
