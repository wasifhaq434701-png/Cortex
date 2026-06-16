import numpy as np
import time

def check_hardware_capabilities():
    """
    Dummy check for hardware capabilities.
    In a real app, you'd check psutil for RAM size or torch for CUDA/MPS.
    """
    try:
        import torch
        if torch.cuda.is_available() or torch.backends.mps.is_available():
            return "high-spec"
    except ImportError:
        pass

    # We can also check total system RAM
    import psutil
    ram_gb = psutil.virtual_memory().total / (1024 ** 3)
    if ram_gb > 16:
        return "high-spec"
    return "low-spec"

def run_predictive_analytics(data_matrix: list, visualize_active: bool = True) -> dict:
    """
    Headless analytics handler. Takes a numerical matrix, routes compute based on hardware,
    and returns structured charting coordinates.
    """
    hardware_level = check_hardware_capabilities()
    print(f"📊 [Predictive Engine] Hardware profile detected: {hardware_level}")

    if not data_matrix or len(data_matrix) < 3:
        return {"error": "Insufficient data for forecasting."}

    y = np.array(data_matrix, dtype=float)
    x = np.arange(len(y))

    forecast = []

    # Normalize inputs so the TF model trains stably (raw indices/values make a
    # tiny dense net diverge), then de-normalize the predictions.
    if hardware_level == "high-spec":
        try:
            import os as _os
            _os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")  # quiet TF banners
            import tensorflow as tf
            print("🧠 [Predictive Engine] Routing to TensorFlow forecaster...")

            x_mean, x_std = x.mean(), (x.std() or 1.0)
            y_mean, y_std = y.mean(), (y.std() or 1.0)
            xn = ((x - x_mean) / x_std).reshape(-1, 1)
            yn = ((y - y_mean) / y_std).reshape(-1, 1)

            model = tf.keras.Sequential([
                tf.keras.layers.Input(shape=(1,)),
                tf.keras.layers.Dense(32, activation='relu'),
                tf.keras.layers.Dense(16, activation='relu'),
                tf.keras.layers.Dense(1)
            ])
            model.compile(optimizer='adam', loss='mse')
            model.fit(xn, yn, epochs=200, verbose=0)

            future_x = np.arange(len(y), len(y) + 5)
            fxn = ((future_x - x_mean) / x_std).reshape(-1, 1)
            preds_n = model.predict(fxn, verbose=0).flatten()
            forecast = (preds_n * y_std + y_mean).tolist()

        except Exception as e:
            print(f"TensorFlow failure, falling back to classic models: {e}")
            hardware_level = "low-spec"

    if hardware_level == "low-spec":
        try:
            from sklearn.linear_model import LinearRegression
            from sklearn.preprocessing import PolynomialFeatures
            from sklearn.metrics import r2_score
            print("⚡ [Predictive Engine] Routing to Scikit-Learn...")

            xr = x.reshape(-1, 1)
            future_x = np.arange(len(y), len(y) + 5).reshape(-1, 1)

            # Pick whichever of linear / quadratic / cubic fits the history best,
            # so forecasts aren't forced into a straight line.
            best = None
            for degree in (1, 2, 3):
                if len(y) <= degree + 1:
                    continue
                poly = PolynomialFeatures(degree=degree)
                model = LinearRegression().fit(poly.fit_transform(xr), y)
                score = r2_score(y, model.predict(poly.transform(xr)))
                if best is None or score > best[0]:
                    best = (score, degree, model, poly)

            if best is None:
                model = LinearRegression().fit(xr, y)
                forecast = model.predict(future_x).tolist()
            else:
                _, _, model, poly = best
                forecast = model.predict(poly.transform(future_x)).tolist()

        except Exception as e:
            return {"error": f"Scikit-learn fallback failed: {e}"}

    # Prepare charting coordinates bypassing Semantic Intent Router
    chart_coordinates = []
    for i, val in enumerate(y):
        chart_coordinates.append({"x": i, "y": float(val), "type": "historical"})

    for i, val in enumerate(forecast):
        chart_coordinates.append({"x": len(y) + i, "y": float(val), "type": "forecast"})

    return {
        "status": "success",
        "hardware_used": hardware_level,
        "visualize_active": visualize_active,
        "chart_data": chart_coordinates
    }
