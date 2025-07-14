export const metadata = {
    title: "Shade3D Viewer",
    description: "Online 3D OBJ viewer with transparency sliders for dentists",
};

export default function RootLayout({ children }) {
    return (
        <html lang="en">
            <body style={{ margin: 0, background: "black" }}>
                {children}
            </body>
        </html>
    );
}
