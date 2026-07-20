/**
 * Table Pivot Icon
 *
 * Source: Material Design Icons by Pictogrammers Team
 * Icon ID: mdi-table-pivot
 * License: Apache License 2.0
 * URL: https://www.iconarchive.com/show/material-icons-by-pictogrammers/table-pivot-icon.html
 * Repository: https://github.com/Templarian/MaterialDesign
 * Website: https://pictogrammers.com/library/mdi/
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Commercial use: ✅ Allowed
 * Modification: ✅ Allowed
 * Distribution: ✅ Allowed
 */

interface TablePivotIconProps {
  className?: string
  size?: number
}

export const TablePivotIcon = ({ className, size = 16 }: TablePivotIconProps) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      fill="currentColor"
    >
      <path d="M22 15H20V18C20 19.11 19.11 20 18 20H15V22L12 19L15 16V18H18V15H16L19 12L22 15M22 4V8C22 9.1 21.1 10 20 10H10V20C10 21.1 9.1 22 8 22H4C2.9 22 2 21.1 2 20V4C2 2.9 2.9 2 4 2H20C21.1 2 22 2.9 22 4M4 8H8V4H4V8M4 10V14H8V10H4M8 20V16H4V20L8 20M14 8V4H10V8H14M20 4L20 4H16V8H20L20 4Z" />
    </svg>
  )
}

/**
 * Table Pivot Icon (Rotated for "Pivot Longer")
 * Same icon but rotated 180 degrees to represent the opposite transformation
 */
export const TablePivotReverseIcon = ({ className, size = 16 }: TablePivotIconProps) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      fill="currentColor"
      style={{ transform: 'rotate(180deg)' }}
    >
      <path d="M22 15H20V18C20 19.11 19.11 20 18 20H15V22L12 19L15 16V18H18V15H16L19 12L22 15M22 4V8C22 9.1 21.1 10 20 10H10V20C10 21.1 9.1 22 8 22H4C2.9 22 2 21.1 2 20V4C2 2.9 2.9 2 4 2H20C21.1 2 22 2.9 22 4M4 8H8V4H4V8M4 10V14H8V10H4M8 20V16H4V20L8 20M14 8V4H10V8H14M20 4L20 4H16V8H20L20 4Z" />
    </svg>
  )
}
