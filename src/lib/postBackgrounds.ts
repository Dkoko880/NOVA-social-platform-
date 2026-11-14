export const postBackgrounds = [
  { label: 'White', value: '#f0f1f5', text: '#666a70' },
  { label: 'Violet', value: '#c600ef', text: '#ffffff' },
  { label: 'Red', value: '#e9003d', text: '#ffffff' },
  { label: 'Black', value: '#111111', text: '#ffffff' },
  { label: 'Berry gradient', value: 'linear-gradient(135deg, #7d18ab, #e60065)', text: '#ffffff' },
  { label: 'Purple gradient', value: 'linear-gradient(135deg, #d320e6, #663be4)', text: '#ffffff' },
  { label: 'Sunset gradient', value: 'linear-gradient(135deg, #ffcb45, #ed168e)', text: '#ffffff' },
] as const

export function getPostBackground(value: string | null | undefined) {
  return postBackgrounds.find((background) => background.value === value)
}
