const Icon = ({ d, size = 18, stroke = 1.5, fill = 'none', style, children }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke="currentColor"
       strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" style={style}>
    {d ? <path d={d} /> : children}
  </svg>
)

export const Icons = {
  Book: (p) => <Icon {...p}><path d="M4 4v16a2 2 0 0 1 2-2h14V4"/><path d="M4 4a2 2 0 0 1 2 2v14"/><path d="M20 4H6a2 2 0 0 0-2 2"/></Icon>,
  Library: (p) => <Icon {...p}><path d="M6 3v18"/><path d="M10 3v18"/><path d="M14 3h6v18h-6z"/><path d="M14 9h6"/></Icon>,
  Chapters: (p) => <Icon {...p}><path d="M3 6h18"/><path d="M3 12h18"/><path d="M3 18h12"/></Icon>,
  Bookmark: (p) => <Icon {...p}><path d="M6 3h12v18l-6-4-6 4z"/></Icon>,
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
}

export default Icons
