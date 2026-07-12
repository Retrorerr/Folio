/* eslint-disable react-refresh/only-export-components */
import type React from 'react'

export type IconProps = Omit<React.SVGProps<SVGSVGElement>, 'stroke'> & {
  d?: string
  size?: number
  stroke?: number | string
}

const Icon = ({ d, size = 18, stroke = 1.5, fill = 'none', style, children, ...props }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke={typeof stroke === 'string' ? stroke : 'currentColor'}
       strokeWidth={typeof stroke === 'number' ? stroke : 1.5} strokeLinecap="round" strokeLinejoin="round" style={style}
       aria-hidden={props['aria-label'] ? undefined : true} focusable="false" {...props}>
    {d ? <path d={d} /> : children}
  </svg>
)

type IconComponent = (props: IconProps) => React.ReactElement

export const Icons = {
  Home: (p) => <Icon {...p}><path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M9 20v-6h6v6"/></Icon>,
  Book: (p) => <Icon {...p}><path d="M4 4v16a2 2 0 0 1 2-2h14V4"/><path d="M4 4a2 2 0 0 1 2 2v14"/><path d="M20 4H6a2 2 0 0 0-2 2"/></Icon>,
  Library: (p) => <Icon {...p}><path d="M6 3v18"/><path d="M10 3v18"/><path d="M14 3h6v18h-6z"/><path d="M14 9h6"/></Icon>,
  Grid: (p) => <Icon {...p}><rect x="4" y="4" width="6" height="6"/><rect x="14" y="4" width="6" height="6"/><rect x="4" y="14" width="6" height="6"/><rect x="14" y="14" width="6" height="6"/></Icon>,
  List: (p) => <Icon {...p}><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/></Icon>,
  Folder: (p) => <Icon {...p}><path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H10l2 2h6.5A2.5 2.5 0 0 1 21 8.5v8A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z"/></Icon>,
  Chapters: (p) => <Icon {...p}><path d="M3 6h18"/><path d="M3 12h18"/><path d="M3 18h12"/></Icon>,
  Bookmark: (p) => <Icon {...p}><path d="M6 3h12v18l-6-4-6 4z"/></Icon>,
  Clock: (p) => <Icon {...p}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l4 2"/></Icon>,
  User: (p) => <Icon {...p}><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></Icon>,
  Users: (p) => <Icon {...p}><path d="M16 21a6 6 0 0 0-12 0"/><circle cx="10" cy="8" r="4"/><path d="M22 21a5 5 0 0 0-5-5"/><path d="M17 4a4 4 0 0 1 0 8"/></Icon>,
  Tag: (p) => <Icon {...p}><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1"/></Icon>,
  Headphones: (p) => <Icon {...p}><path d="M4 14a8 8 0 0 1 16 0"/><path d="M4 14v4a2 2 0 0 0 2 2h2v-7H6a2 2 0 0 0-2 2z"/><path d="M20 14v4a2 2 0 0 1-2 2h-2v-7h2a2 2 0 0 1 2 2z"/></Icon>,
  Note: (p) => <Icon {...p}><path d="M7 3h8l4 4v14H7z"/><path d="M15 3v5h5"/><path d="M10 12h6"/><path d="M10 16h6"/></Icon>,
  Highlight: (p) => <Icon {...p}><path d="m6 20 9.5-9.5a2.1 2.1 0 0 0-3-3L3 17v3z"/><path d="m14 6 4 4"/><path d="M13 20h8"/></Icon>,
  Sun: (p) => <Icon {...p}><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></Icon>,
  Settings: (p) => <Icon {...p}><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></Icon>,
  Search: (p) => <Icon {...p}><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></Icon>,
  Play: (p) => <Icon fill="currentColor" stroke="none" {...p}><path d="M7 4v16l14-8z"/></Icon>,
  Pause: (p) => <Icon fill="currentColor" stroke="none" {...p}><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></Icon>,
  SkipBack: (p) => <Icon fill="currentColor" stroke="none" {...p}><path d="M6 5v14h2V5zM20 5l-11 7 11 7z"/></Icon>,
  SkipForward: (p) => <Icon fill="currentColor" stroke="none" {...p}><path d="M4 5l11 7-11 7zM16 5h2v14h-2z"/></Icon>,
  Rewind: (p) => <Icon {...p}><path d="M11 17 6 12l5-5"/><path d="M18 17l-5-5 5-5"/></Icon>,
  Forward: (p) => <Icon {...p}><path d="m13 17 5-5-5-5"/><path d="m6 17 5-5-5-5"/></Icon>,
  ArrowRight: (p) => <Icon {...p}><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></Icon>,
  ArrowLeft: (p) => <Icon {...p}><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></Icon>,
  ChevronDown: (p) => <Icon {...p}><path d="m6 9 6 6 6-6"/></Icon>,
  ChevronLeft: (p) => <Icon {...p}><path d="m15 18-6-6 6-6"/></Icon>,
  ChevronRight: (p) => <Icon {...p}><path d="m9 18 6-6-6-6"/></Icon>,
  X: (p) => <Icon {...p}><path d="M18 6 6 18"/><path d="m6 6 12 12"/></Icon>,
  Plus: (p) => <Icon {...p}><path d="M12 5v14"/><path d="M5 12h14"/></Icon>,
  Trash: (p) => <Icon {...p}><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></Icon>,
  Upload: (p) => <Icon {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/></Icon>,
  Download: (p) => <Icon {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></Icon>,
  Volume: (p) => <Icon {...p}><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a9 9 0 0 1 0 14"/></Icon>,
  Speed: (p) => <Icon {...p}><path d="M12 3v3"/><path d="M5.64 7.64l2.12 2.12"/><path d="M12 12l5-3"/><circle cx="12" cy="12" r="9"/></Icon>,
  Moon: (p) => <Icon {...p}><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></Icon>,
  Sleep: (p) => <Icon {...p}><path d="M3 12a9 9 0 1 0 9-9"/><path d="M12 7v5l3 2"/></Icon>,
  Feather: (p) => <Icon {...p}><path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z"/><path d="M16 8 2 22"/><path d="M17.5 15H9"/></Icon>,
  Dots: (p) => <Icon {...p}><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></Icon>,
  Stop: (p) => <Icon fill="currentColor" stroke="none" {...p}><path d="M6 6h12v12H6z"/></Icon>,
  Locate: (p) => <Icon {...p}><circle cx="12" cy="12" r="3"/><path d="M12 2v3"/><path d="M12 19v3"/><path d="M2 12h3"/><path d="M19 12h3"/></Icon>,
} satisfies Record<string, IconComponent>

export default Icons
